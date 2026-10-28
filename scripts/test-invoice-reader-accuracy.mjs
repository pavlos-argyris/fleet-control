import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reader-accuracy-'));
try {
  // Small JSON dependency fixtures allow the actual Android parser to run on a JVM.
  fs.writeFileSync(path.join(temp, 'JSONObject.java'), `package org.json;
import java.util.*;
public class JSONObject {
  final Map<String,Object> data = new LinkedHashMap<String,Object>();
  public JSONObject() {} public JSONObject put(String key,Object value) { data.put(key,value); return this; }
  public String optString(String key) { return optString(key, ""); }
  public String optString(String key,String fallback) { Object value=data.get(key); return value==null ? fallback : value.toString(); }
  public int optInt(String key,int fallback) { Object value=data.get(key); return value instanceof Number ? ((Number)value).intValue() : fallback; }
  public JSONArray optJSONArray(String key) { Object value=data.get(key); return value instanceof JSONArray ? (JSONArray)value : null; }
}`);
  fs.writeFileSync(path.join(temp, 'JSONArray.java'), `package org.json;
import java.util.*;
public class JSONArray {
  final List<Object> data=new ArrayList<Object>();
  public JSONArray put(Object value) { data.add(value); return this; }
  public int length() { return data.size(); } public String optString(int index) { return data.get(index).toString(); }
}`);
  const lines = ['TEST MOTO Ο.Ε.', 'Ημερομηνία Παράδοσης 2026-09-01', 'Είδος Παραστατικού Αριθμός Ημερομηνία Έκδοσης', 'Τιμολόγιο ΤΔΑ0000001 02/08/2026', 'Κωδικός Περιγραφή Ποσότητα', 'L00000000001 ΛΑΔΙ 1,00 Τεμάχια 8,07', 'YAMALUBE', '20W50', 'L00000000002 ΑΛΥΣΙΔΑ 1,00 Τεμάχια 8,07', '420/112', 'MHQ', 'Εκπτώσεις/Χρεώσεις', 'Σύνολο Καθαρού Ποσού 27,42', 'Σύνολο Φ.Π.Α 6,58', 'Συνολική Αξία 34,00', 'Προηγούμενο Υπόλοιπο 21.320,32', 'Νέο Υπόλοιπο 21.354,32', 'Όροι Πληρωμής Συναλλαγής Τοίς Μετρητοίς', 'Σχόλια', 'BTO 1234', '82.385', 'Μ.Αρ.Κ. 999999999999999 Υπογραφή 12345'];
  const chars = [...new Set(lines.join('').split(''))];
  const codes = new Map(chars.map((char, index) => [char, index + 1]));
  const hex = value => value.toString(16).padStart(2, '0');
  const cmap = `${chars.length} beginbfchar\n` + chars.map(char => `<${hex(codes.get(char))}> <${char.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n') + '\nendbfchar';
  const stream = (number, text) => `${number} 0 obj\n<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream\nendobj\n`;
  const content = group => group.map((line, index) => `BT /F1 10 Tf 1 0 0 -1 20 ${index * 20} Tm <${line.split('').map(char => hex(codes.get(char))).join('')}> Tj ET`).join('\n');
  const fixture = `%PDF-1.4\n1 0 obj\n<< /Type /Page /Resources << /Font << /F1 4 0 R >> >> /Contents [2 0 R 3 0 R] >>\nendobj\n` + stream(2, content(lines.slice(0, 12))) + stream(3, content(lines.slice(12))) + '4 0 obj\n<< /Type /Font /Subtype /Type3 /ToUnicode 5 0 R >>\nendobj\n' + stream(5, cmap);
  fs.writeFileSync(path.join(temp, 'invoice.pdf'), fixture);
  fs.writeFileSync(path.join(temp, 'ReaderAccuracyTest.java'), `
import gr.argyrismitsos.fleetserver.LocalInvoiceReader;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
public class ReaderAccuracyTest {
  static void check(boolean value,String message) { if(!value) throw new AssertionError(message); }
  static void equal(String value,Object actual) { check(value.equals(actual),"Expected "+value+", got "+actual); }
  static String field(String method,String value) throws Exception { Method m=LocalInvoiceReader.class.getDeclaredMethod(method,String.class);m.setAccessible(true);return (String)m.invoke(null,value); }
  public static void main(String[] args) throws Exception {
    File fixture=new File(args[0]); JSONObject data=LocalInvoiceReader.read(fixture);
    equal("BTO-1234",data.optString("plate")); equal("82385",data.optString("odometerKm"));
    equal("2026-08-02",data.optString("invoiceDate")); equal("34,00",data.optString("totalAmount"));
    equal("TEST MOTO Ο.Ε.",data.optString("supplier")); equal("ΤΔΑ0000001",data.optString("invoiceNumber"));
    equal("confident",data.optString("localReadStatus")); check(data.optJSONArray("workPerformed").length()==2,"item count");
    equal("ΛΑΔΙ YAMALUBE 20W50",data.optJSONArray("workPerformed").optString(0));
    equal("ΑΛΥΣΙΔΑ 420/112 MHQ",data.optJSONArray("workPerformed").optString(1));
    equal("",field("findCommentNumber","BTO 1234")); equal("82385",field("findCommentNumber","BTO 1234 82.385"));
    equal("",field("findCommentNumber","BTO 1234 82385 95000"));
    equal("2024-02-29",field("findDate","Ημερομηνία Έκδοσης 29/02/2024"));
    equal("",field("findDate","Ημερομηνία Έκδοσης 31/02/2026\\nΗμερομηνία Παράδοσης 01/03/2026"));
    equal("",field("findInvoiceTotal","Σύνολο Καθαρού Ποσού 27,42\\nΝέο Υπόλοιπο 21354,32"));
    equal("34.00",field("findInvoiceTotal","Σύνολο 34.00"));
    equal("27,42",data.optString("netAmount"));equal("6,58",data.optString("vatAmount"));
    String actual=data.optString("rawText");
    JSONObject labelled=LocalInvoiceReader.readText(actual.replace("82.385","χλμ: 82.385")); equal("82385",labelled.optString("odometerKm"));
    JSONObject sku=LocalInvoiceReader.readText(actual.replace("Σχόλια","KM95000 Κωδικός είδους\\nΣχόλια")); equal("82385",sku.optString("odometerKm"));
    JSONObject same=LocalInvoiceReader.readBest(fixture,actual.replace("BTO 1234","ΒΤΟ 1234").replace("34,00","34.00"));
    equal("confident",same.optString("localReadStatus"));
    JSONObject conflict=LocalInvoiceReader.readBest(fixture,actual.replace("Συνολική Αξία 34,00","Συνολική Αξία 99,00"));
    equal("ambiguous",conflict.optString("localReadStatus")); check(conflict.optInt("ocrConfidence",100)<=60,"conflict must trigger AI fallback");
    StringBuilder longText=new StringBuilder(actual.substring(0,actual.indexOf("Σχόλια")));
    for(int i=0;i<1000;i++)longText.append("\\nουδέτερο κείμενο ");
    longText.append("\\nΣχόλια BTO 1234\\n82385\\nΜ.Αρ.Κ. 999999999999999");
    JSONObject late=LocalInvoiceReader.readText(longText.toString()); equal("82385",late.optString("odometerKm"));
    equal("BTO-1234",late.optString("plate")); check(late.optString("rawText").length()>6000,"full parse evidence retained beyond 6000 chars");
    if(args.length>1) {
      JSONObject sample=LocalInvoiceReader.read(new File(args[1]));
      equal("TNH-921",sample.optString("plate"));equal("82385",sample.optString("odometerKm"));
      equal("2026-08-17",sample.optString("invoiceDate"));equal("34,00",sample.optString("totalAmount"));
      check(sample.optJSONArray("workPerformed").length()==4,"uploaded PDF items");
      System.out.println("OK uploaded PDF: actual parser plate/date/km/total and four multi-line items.");
    }
    System.out.println("OK actual Java reader: mapped Contents arrays, multiline descriptions/comments, issue date validation, gross totals, no plate-as-mileage, conflicting sources and footer fields beyond 6000 chars.");
  }
}`);
  execFileSync('java', ['-jar', path.join(root, '.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'), '-proc:none', '-source', '8', '-target', '8', '-nowarn', '-encoding', 'UTF-8', '-d', temp,
    path.join(root, 'server-android/src/gr/argyrismitsos/fleetserver/LocalInvoiceReader.java'), ...['JSONObject.java', 'JSONArray.java', 'ReaderAccuracyTest.java'].map(file => path.join(temp, file))], { stdio: 'inherit' });
  execFileSync('java', ['-cp', temp, 'ReaderAccuracyTest', path.join(temp, 'invoice.pdf'), ...process.argv.slice(2)], { stdio: 'inherit' });
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
