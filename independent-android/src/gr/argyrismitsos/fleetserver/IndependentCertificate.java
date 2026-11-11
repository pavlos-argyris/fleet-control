package gr.argyrismitsos.fleetserver;

import java.io.*;
import java.net.*;
import java.security.cert.*;
import java.util.*;
import javax.net.ssl.*;
import org.json.*;

/** Owner diagnostics contain fixed labels/codes only, never exception/provider text. */
public final class IndependentCertificate {
    private IndependentCertificate(){}
    static final class Failure extends IOException {
        private static final long serialVersionUID=1L;
        final String phase,reason;final int status;final long retryAt;
        Failure(String phase,String reason,int status,long retryAt){super(code(phase,reason,status));this.phase=phase;this.reason=reason;this.status=status>=100&&status<=599?status:0;this.retryAt=retryAt;}
    }
    static String phase(String phase){
        if("storage".equals(phase))return "Προετοιμασία προστατευμένου κλειδιού";
        if("directory".equals(phase))return "Σύνδεση με Let's Encrypt";
        if("account".equals(phase))return "Επιβεβαίωση λογαριασμού πιστοποιητικού";
        if("order".equals(phase))return "Αίτημα πιστοποιητικού";
        if("txt_set".equals(phase))return "Εγγραφή επαλήθευσης DNS";
        if("txt_wait".equals(phase))return "Αναμονή δημοσίευσης εγγραφής DNS";
        if("authorization".equals(phase))return "Έλεγχος ονόματος από Let's Encrypt";
        if("ready".equals(phase))return "Αναμονή ετοιμότητας πιστοποιητικού";
        if("finalize".equals(phase))return "Υπογραφή πιστοποιητικού";
        if("download".equals(phase))return "Λήψη αλυσίδας πιστοποιητικού";
        if("chain".equals(phase))return "Έλεγχος εμπιστοσύνης και αποθήκευση";
        if("address".equals(phase))return "Ενημέρωση διεύθυνσης DNS";
        return "Προετοιμασία HTTPS";
    }
    private static String allowed(String value,String[] allowed,String fallback){for(String item:allowed)if(item.equals(value))return item;return fallback;}
    private static String code(String phase,String reason,int status){
        phase=allowed(phase,new String[]{"storage","directory","account","order","txt_set","txt_wait","authorization","ready","finalize","download","chain","address"},"https");
        reason=allowed(reason,new String[]{"CAA","CA_DNS","CA_UNAUTHORIZED","CA_RATE_LIMIT","CA_NONCE","CA_ORDER_NOT_READY","CA_REJECTED","CA_RESPONSE","CA_PENDING","DNS_SERVFAIL","DNS_UNAVAILABLE","DNS_PENDING","DNS_REJECTED","TIMEOUT","TLS","CLOCK","STORAGE","CHAIN","NETWORK","UNKNOWN"},"UNKNOWN");
        return "CERT_"+phase.toUpperCase(Locale.US)+"_"+reason+(status>=100&&status<=599?"_HTTP"+status:"");
    }
    static Failure classify(String phase,Exception error){
        if(error instanceof Failure)return (Failure)error;
        String reason="UNKNOWN";Throwable value=error;
        for(int i=0;value!=null&&i<8;i++,value=value.getCause()){
            if(value instanceof CertificateExpiredException||value instanceof CertificateNotYetValidException){reason="CLOCK";break;}
            if(value instanceof SocketTimeoutException||value instanceof InterruptedIOException)reason="TIMEOUT";
            else if(value instanceof UnknownHostException)reason="DNS_UNAVAILABLE";
            else if(value instanceof SSLException||value instanceof CertificateException)reason="TLS";
            else if(value instanceof JSONException)reason="CA_RESPONSE";
            else if(value instanceof IOException&&reason.equals("UNKNOWN"))reason="NETWORK";
        }
        if("storage".equals(phase))reason="STORAGE";
        if("chain".equals(phase)&&!reason.equals("CLOCK"))reason="CHAIN";
        return new Failure(phase,reason,0,0);
    }
    private static String caReason(JSONObject problem){
        String type=problem.optString("type");
        if(type.equals("urn:ietf:params:acme:error:caa"))return "CAA";
        if(type.equals("urn:ietf:params:acme:error:dns"))return "CA_DNS";
        if(type.equals("urn:ietf:params:acme:error:unauthorized"))return "CA_UNAUTHORIZED";
        if(type.equals("urn:ietf:params:acme:error:rateLimited"))return "CA_RATE_LIMIT";
        if(type.equals("urn:ietf:params:acme:error:badNonce"))return "CA_NONCE";
        if(type.equals("urn:ietf:params:acme:error:orderNotReady"))return "CA_ORDER_NOT_READY";
        return "CA_REJECTED";
    }
    static Failure problem(String phase,String body,int status,long retryAt){
        String reason=status==429?"CA_RATE_LIMIT":"CA_REJECTED";
        try{JSONObject root=new JSONObject(body);reason=caReason(root);JSONArray children=root.optJSONArray("subproblems");if(children!=null)for(int i=0;i<Math.min(16,children.length());i++){String child=caReason(children.getJSONObject(i));if(child.equals("CAA")||child.equals("CA_DNS")){reason=child;break;}}}catch(Exception ignored){}
        if(status==429)reason="CA_RATE_LIMIT";
        return new Failure(phase,reason,status,retryAt);
    }
    static Failure resource(String phase,JSONObject resource){
        JSONObject error=resource.optJSONObject("error");
        JSONArray challenges=resource.optJSONArray("challenges");if(error==null&&challenges!=null)for(int i=0;i<Math.min(16,challenges.length());i++){JSONObject challenge=challenges.optJSONObject(i);if(challenge!=null&&challenge.optString("type").equals("dns-01")){error=challenge.optJSONObject("error");if(error!=null)break;}}
        return error==null?new Failure(phase,"CA_REJECTED",0,0):problem(phase,error.toString(),0,0);
    }
    static long retryAfter(String header,long now){
        if(header==null)return 0;
        try{long seconds=Long.parseLong(header.trim());if(seconds>=0)return Math.addExact(now,Math.multiplyExact(seconds,1000L));}catch(Exception ignored){}
        try{java.text.SimpleDateFormat format=new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz",Locale.US);format.setLenient(false);return Math.max(now,format.parse(header).getTime());}catch(Exception ignored){return 0;}
    }
    static long nextRetry(long now,int failures,Exception error){long normal=now+Math.min(21600000L,300000L*(1L<<Math.min(7,Math.max(1,failures))));return Math.max(normal,error instanceof Failure?((Failure)error).retryAt:0);}
    static String describe(Exception error,long retryAt){
        Failure failure=classify("https",error);String reason=failure.reason;
        String message=reason.equals("CAA")?"Ο πάροχος απέρριψε τον έλεγχο CAA του DNS.":reason.equals("CA_DNS")?"Ο πάροχος πιστοποιητικών ανέφερε σφάλμα DNS.":reason.equals("CA_UNAUTHORIZED")?"Δεν επιβεβαιώθηκε η κυριότητα του ονόματος.":reason.equals("CA_RATE_LIMIT")?"Ο πάροχος περιόρισε τις προσπάθειες· τηρείται η αναμονή του.":reason.equals("DNS_SERVFAIL")?"Το δημόσιο DNS επέστρεψε SERVFAIL.":reason.equals("DNS_PENDING")?"Η εγγραφή επαλήθευσης δεν εμφανίστηκε ακόμη στο δημόσιο DNS.":reason.equals("DNS_REJECTED")?"Το DuckDNS δεν δέχθηκε την εγγραφή επαλήθευσης.":reason.equals("DNS_UNAVAILABLE")?"Δεν επιβεβαιώθηκε η δημόσια απόκριση DNS.":reason.equals("TIMEOUT")?"Έληξε η αναμονή απάντησης δικτύου.":reason.equals("TLS")?"Δεν επιβεβαιώθηκε η ασφαλής σύνδεση με τον πάροχο.":reason.equals("CLOCK")?"Το πιστοποιητικό δεν ισχύει για την ώρα της συσκευής· έλεγξε ημερομηνία/ώρα.":reason.equals("STORAGE")?"Δεν ανοίχθηκε το προστατευμένο κλειδί της συσκευής.":reason.equals("CHAIN")?"Δεν επαληθεύτηκαν η έμπιστη αλυσίδα και το κλειδί του πιστοποιητικού.":reason.equals("CA_PENDING")||reason.equals("CA_ORDER_NOT_READY")?"Το αίτημα παραμένει σε αναμονή στον πάροχο.":reason.equals("CA_RESPONSE")?"Ο πάροχος δεν επέστρεψε συμβατή απάντηση.":reason.equals("NETWORK")?"Η επικοινωνία δεν ολοκληρώθηκε.":"Η ενέργεια δεν επιβεβαιώθηκε.";
        String text=phase(failure.phase)+": "+message+" ["+code(failure.phase,reason,failure.status)+"]";
        if(retryAt>0)text+="\nΕπόμενη αυτόματη προσπάθεια: "+new java.text.SimpleDateFormat("dd/MM HH:mm",Locale.US).format(new Date(retryAt));
        return text;
    }
}
