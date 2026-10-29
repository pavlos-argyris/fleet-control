import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {invoiceText} from './fixtures/invoice-layout.mjs';
const root=path.resolve('.'),folder=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-reader-full-')),jar=path.join(root,'vendor/json-java/json-20240303.jar');
try {
 const text=('Συνθετική επικεφαλίδα χωρίς δεδομένα '.repeat(100)+'\n')+invoiceText({count:120}).replace('Σελίδα 2','Εκπτώσεις/Χρεώσεις\nΣελίδα 2').replace('Εργασία 1 1,00','ΦΙΛΤΡΟ ΛΑΔΙΟΥ 1,00').replace('Εργασία 3 1,00','φίλτρο λαδιού 1,00').replace('Εργασία 4 1,00','ΦΙΛΤΡΟ\nΛΑΔΙΟΥ 1,00');
 fs.writeFileSync(path.join(folder,'full.txt'),text);
 // Multiple PDF Page objects, each with its own /Contents, share the same
 // synthetic Unicode font. Exercise the real parser, not a JS translation.
 const lines=text.split('\n'),chars=[...new Set(text.replaceAll('\n',''))],codes=new Map(chars.map((c,i)=>[c,i+1]));
 const hex=n=>n.toString(16).padStart(4,'0');
 const stream=(id,value)=>`${id} 0 obj\n<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream\nendobj\n`;
 const cmap=`${chars.length} beginbfchar\n`+chars.map(c=>`<${hex(codes.get(c))}> <${hex(c.charCodeAt(0))}>`).join('\n')+'\nendbfchar';
 let pdf='%PDF-1.4\n';
 for(let i=0;i<lines.length;i+=24){const id=10+i;pdf+=`${id} 0 obj\n<< /Type /Page /Resources << /Font << /F1 2 0 R >> >> /Contents ${id+1} 0 R >>\nendobj\n`;
   const content=lines.slice(i,i+24).map((line,row)=>`BT /F1 10 Tf 1 0 0 -1 20 ${20*row} Tm <${[...line].map(c=>hex(codes.get(c))).join('')}> Tj ET`).join('\n');pdf+=stream(id+1,content);}
 pdf+='2 0 obj\n<< /Type /Font /Subtype /Type3 /ToUnicode 3 0 R >>\nendobj\n'+stream(3,cmap)+'%%EOF';
 fs.writeFileSync(path.join(folder,'full.pdf'),pdf);
 fs.writeFileSync(path.join(folder,'ReaderFullTest.java'),`import java.io.*;import org.json.*;import gr.argyrismitsos.fleetserver.LocalInvoiceReader;
public class ReaderFullTest {
 static void check(boolean good,String label){if(!good)throw new AssertionError(label);}
 public static void main(String[] args)throws Exception {
  String raw=new String(java.nio.file.Files.readAllBytes(java.nio.file.Paths.get(args[0])),"UTF-8");
  for(JSONObject value:new JSONObject[]{LocalInvoiceReader.readText(raw),LocalInvoiceReader.read(new File(args[1])),LocalInvoiceReader.readBest(new File(args[1]),raw.substring(0,raw.indexOf("Σελίδα 3")))}){
   check(value.getJSONArray("lineItems").length()==120,"all 120 rows/pages retained, got "+value.getJSONArray("lineItems").length());
   check(value.optString("rawText").length()>6000,"full evidence beyond old 6000-char boundary");
   check(value.optString("plate").equals("ΒΤΟ-756"),"comments plate");check(value.optString("odometerKm").equals("9000"),"numeric-only km");
   check(value.optString("invoiceNumber").equals("ΤΔΑ0000123"),"clear invoice number");
   check(value.optJSONObject("fieldEvidence").optJSONObject("plate").optInt("score")>=85,"normalized plate retains specific evidence, not 55");
  }
  JSONObject filterPdf=LocalInvoiceReader.read(new File(args[1]));
  java.nio.file.Files.write(java.nio.file.Paths.get(args[2]),filterPdf.toString().getBytes("UTF-8"));
  JSONObject duplicate=LocalInvoiceReader.readText(raw.replace("Εργασία 2 ","Εργασία 1 "));
  check(duplicate.getJSONArray("lineItems").length()==120,"identical descriptions are separate invoice rows");
  JSONObject ambiguous=LocalInvoiceReader.readText(raw.replace("9000","9000 10000"));check(!ambiguous.optString("localReadStatus").equals("confident"),"ambiguous comments are not confident");
  System.out.println("PASS actual Java parser: all 120 rows across multiple PDF Page/Contents objects and interim page subtotal, duplicate descriptions, full evidence, clear invoice number and longer PDF preferred over partial DOM.");
 }}
`);
 execFileSync('java',['-jar',path.join(root,'.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-cp',jar,'-d',folder,path.join(root,'server-android/src/gr/argyrismitsos/fleetserver/LocalInvoiceReader.java'),path.join(folder,'ReaderFullTest.java')]);
 execFileSync('java',['-cp',folder+path.delimiter+jar,'ReaderFullTest',path.join(folder,'full.txt'),path.join(folder,'full.pdf'),path.join(folder,'filter.json')],{stdio:'inherit'});
 const actual=JSON.parse(fs.readFileSync(path.join(folder,'filter.json'),'utf8'));
 const {normalizeFleet}=await import('../cloudflare-worker/src/worker.js');
 const saved=normalizeFleet({bikes:[{id:'filter',name:'BTO-756',currentKm:9000,history:[{id:'filter-service',type:'service',km:9000,date:'2026-10-28',tasks:['Αλλαγή λαδιών',...actual.lineItems]}]}]}).bikes[0].history[0];
 assert.ok(saved.tasks.some(t=>/φιλτρο\s+λαδιου/.test(t.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase())),JSON.stringify(saved.tasks));
 assert.ok(saved.tasks.some(t=>/Αλλαγή λαδιών/.test(t)),'filter stays separate from oil task through real PDF/native/normalization');
 assert.ok(text.length>6000);
} finally {fs.rmSync(folder,{recursive:true,force:true});}
