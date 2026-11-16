import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {pdfboxFixture} from './fixtures/pdfbox.mjs';
import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';
const root=process.cwd(),temp=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-finance-export-')),out=path.resolve('.build/verification/financial-export');fs.mkdirSync(out,{recursive:true});
const require=createRequire(new URL('../cloudflare-worker/package.json',import.meta.url));
try{
 execFileSync('python3',['scripts/prepare-invoice-dependencies.py','.build/business-build-deps'],{stdio:'inherit'});
 const {build}=require('esbuild');const bundled=await build({stdin:{contents:"export {cashExportSpec,storeExportSpec,storeSummaryExportSpec} from './server-runtime/exports.js';",resolveDir:root},bundle:true,write:false,format:'iife',globalName:'FinancialSpecs',platform:'neutral',mainFields:['browser','module','main']});
 const context=vm.createContext({__fleetNative(){throw Error('Export specification unexpectedly requested native I/O');}});vm.runInContext(bundled.outputFiles[0].text,context);const api=context.FinancialSpecs;
 const cash=api.cashExportSpec({from:'2026-11-04',to:'2026-11-04',couriers:[{courierName:'Συνθετικός διανομέας',orders:15,dueCents:3000,receivedCents:2000,balanceCents:1000,breakdown:[{storeId:'Δοκιμαστικό κατάστημα',category:'Α',orders:15,dueCents:3000}]}],events:[]});
 assert.deepEqual(JSON.parse(JSON.stringify(cash.tables[0].rows[0])),['Συνθετικός διανομέας',15,3000]);
 const source={from:'2026-11-01',to:'2026-11-30',observedAt:'2026-12-01T08:00:00Z',coverageVerified:false,groups:Array.from({length:86},(_,i)=>({period:'2026-11',storeName:i===0?'=SUM(A1:A2)':'Δοκιμαστικό κατάστημα '+i+' - Αναλυτική περιγραφή με ελληνικά γράμματα',orderCount:i===3?null:18,orderChargeCents:i===3?null:3600,minimumTopUpCents:i===3?null:400,totalChargeCents:i===3?null:4000,coverageVerified:i!==3})),daily:[]};
 const report=api.storeExportSpec(source);
 const compactSource={from:'2026-10-01',to:'2026-10-31',observedAt:'2026-11-01T08:00:00Z',coverageVerified:true,stores:Array.from({length:40},(_,i)=>({id:'shop-'+i,name:'Κατάστημα '+String(i).padStart(2,'0')})),daily:Array.from({length:31},(_,d)=>Array.from({length:40},(_,i)=>({day:'2026-10-'+String(d+1).padStart(2,'0'),storeId:'shop-'+i,storeName:'Κατάστημα '+String(i).padStart(2,'0'),coverageVerified:true,orderCount:1,orderChargeCents:200,minimumTopUpCents:100,totalChargeCents:300}))).flat()};
 const compact=api.storeSummaryExportSpec(compactSource);assert.equal(compact.tables[0].rows.length,41);assert.equal(compact.tables[1].rows.length,32);assert.equal(compact.metrics[0].value,1240);assert.equal(compact.metrics[3].value,372000);fs.writeFileSync(path.join(out,'summary-spec.json'),JSON.stringify(compact));
 compactSource.daily[0].coverageVerified=false;const partial=api.storeSummaryExportSpec(compactSource);assert(partial.metrics.every(m=>m.value===null));assert.equal(partial.tables[0].rows[0][4],null,'unknown is never converted to confirmed zero');
 fs.writeFileSync(path.join(out,'cash-spec.json'),JSON.stringify(cash));fs.writeFileSync(path.join(out,'stores-spec.json'),JSON.stringify(report));
 const write=(name,value)=>fs.writeFileSync(path.join(temp,name),value);
 pdfboxFixture(temp);
 write('ExportTest.java',String.raw`import org.json.*;import java.io.*;import java.nio.file.*;import gr.argyrismitsos.fleetserver.FinancialExport;import com.tom_roush.pdfbox.android.PDFBoxResourceLoader;
 public class ExportTest{public static void main(String[] args)throws Exception{FinancialExport.initializePdf(new android.content.Context(args[0]));for(String name:new String[]{"cash","stores","summary"}){JSONObject spec=new JSONObject(new String(Files.readAllBytes(Paths.get(args[1],name+"-spec.json")),"UTF-8"));FinancialExport.writeXlsx(new File(args[1],name+".xlsx"),spec);FinancialExport.writePdf(new File(args[1],name+".pdf"),spec,new FileInputStream(new File(args[0],"com/tom_roush/pdfbox/resources/ttf/LiberationSans-Regular.ttf")));}System.out.println("PASS real native PDFBox/OOXML writes from the exact shared API export specifications.");}}
 `);
 write('ExportWithoutInit.java',String.raw`import org.json.*;import java.io.*;import java.nio.file.*;import gr.argyrismitsos.fleetserver.FinancialExport;public class ExportWithoutInit{public static void main(String[] args)throws Exception{JSONObject spec=new JSONObject(new String(Files.readAllBytes(Paths.get(args[1],"summary-spec.json")),"UTF-8"));try{FinancialExport.writePdf(new File(args[1],"without-init.pdf"),spec,new FileInputStream(new File(args[0],"com/tom_roush/pdfbox/resources/ttf/LiberationSans-Regular.ttf")));System.out.println("No missing-init failure reproduced in this JVM adapter.");}catch(Throwable expected){System.out.println("REPRODUCED missing PDFBox initialization: "+expected.getClass().getSimpleName());}}}`);
 const jars=[path.join(root,'vendor/json-java/json-20240303.jar'),...fs.readdirSync('.build/business-build-deps/jars').filter(n=>n.endsWith('.jar')).map(n=>path.resolve('.build/business-build-deps/jars',n))].join(path.delimiter);
 execFileSync('java',['-jar',path.resolve('.android-toolchain/usr/share/java/eclipse-jdt-core-3.32.0.jar'),'-proc:none','-source','8','-target','8','-nowarn','-encoding','UTF-8','-classpath',jars,'-d',temp,path.resolve('server-android/src/gr/argyrismitsos/fleetserver/FinancialExport.java'),...fs.readdirSync(temp).filter(n=>n.endsWith('.java')).map(n=>path.join(temp,n))],{stdio:'inherit'});
 execFileSync('java',['-Xmx256m','-cp',temp+path.delimiter+jars,'ExportWithoutInit',path.resolve('.build/business-build-deps/assets'),out],{stdio:'inherit',timeout:60000});
 execFileSync('java',['-Xmx256m','-cp',temp+path.delimiter+jars,'ExportTest',path.resolve('.build/business-build-deps/assets'),out],{stdio:'inherit',timeout:60000});
 execFileSync(process.env.FLEET_FINANCE_PYTHON||'python3',['-c',String.raw`from pathlib import Path
import openpyxl
from pypdf import PdfReader
root=Path(__import__('sys').argv[1])
c=openpyxl.load_workbook(root/'cash.xlsx',data_only=False)
assert c.worksheets[0]['C2'].value==30 and c.worksheets[0].max_column==3
assert c.worksheets[1]['E2'].value==30, 'store breakdown equals delivery due'
assert c.worksheets[0]['C2'].data_type=='n' and '0.00' in c.worksheets[0]['C2'].number_format
s=openpyxl.load_workbook(root/'stores.xlsx',data_only=False)
assert s.worksheets[0]['B2'].value=='=SUM(A1:A2)' and s.worksheets[0]['B2'].data_type=='s'
assert s.worksheets[0]['F2'].value==40 and s.worksheets[0]['F5'].value=='Άγνωστο'
p=PdfReader(root/'stores.pdf');assert len(p.pages)>=3
t='\n'.join(page.extract_text() for page in p.pages)
assert 'Οικονομικά καταστημάτων' in t and 'Άγνωστο' in t and '40,00' in t and '85' in t
assert any('Στοιχεία αναφοράς' in page.extract_text() for page in p.pages), 'PDF must include subsequent tables'
summary=PdfReader(root/'summary.pdf');assert 2<=len(summary.pages)<=4
summary_text='\n'.join(page.extract_text() for page in summary.pages)
for i in range(40): assert 'Κατάστημα '+str(i).zfill(2) in summary_text
for d in range(1,32): assert '2026-10-'+str(d).zfill(2) in summary_text
assert 'ΣΥΝΟΠΤΙΚΗ ΑΝΑΦΟΡΑ ΚΑΤΑΣΤΗΜΑΤΩΝ' in summary_text and ('3.720,00' in summary_text or '3720,00' in summary_text)
assert 'Ημερήσια συγκεντρωτικά' in summary_text and 'Συνολική χρέωση περιόδου' in summary_text
assert all(abs(float(page.mediabox.width)-841.89)<1 and abs(float(page.mediabox.height)-595.28)<1 for page in summary.pages)
q='\n'.join(page.extract_text() for page in PdfReader(root/'cash.pdf').pages)
assert 'Συνθετικός διανομέας' in q and '30,00' in q and 'Παραδόθηκαν' not in q and 'Υπόλοιπο' not in q
print('PASS independent openpyxl/pypdf: numeric exact money, unknown cells, Greek text, formula injection kept as text, repeated headers and complete multiple pages.')
`,out],{stdio:'inherit'});
 execFileSync('pdftoppm',['-f','1','-singlefile','-scale-to','1500','-png',path.join(out,'stores.pdf'),path.join(out,'stores-first')],{stdio:'inherit'});
 console.log('PASS financial export artifacts: '+out);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
