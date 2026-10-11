import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../cloudflare-worker/public/service-model.js';
const pdfjs=await import('../cloudflare-worker/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',null,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',null,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
for(const [i,text] of [[3,'BTO-756 9500 11/10/2026 59,00'],[5,'Second page']]){const stream='BT /F1 16 Tf 50 700 Td ('+text+') Tj ET';objects[i]='<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream';}
let raw='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(raw));raw+=(i+1)+' 0 obj\n'+o+'\nendobj\n';});const pos=Buffer.byteLength(raw);raw+='xref\n0 8\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n'+pos+'\n%%EOF';
const task=pdfjs.getDocument({data:new Uint8Array(Buffer.from(raw)),isEvalSupported:false});const doc=await task.promise;assert.equal(doc.numPages,2);const text=await(await doc.getPage(1)).getTextContent();assert.ok(text.items.some(i=>i.str.includes('BTO-756')&&i.transform.length===6));await task.destroy();
const ctx=vm.createContext({URL,console,FleetServiceModel:globalThis.FleetServiceModel,document:{currentScript:{src:'https://fixture.invalid/service-tools.js'},addEventListener(){}},location:{href:'https://fixture.invalid/',protocol:'https:'}});vm.runInContext(fs.readFileSync('cloudflare-worker/public/service-tools.js','utf8'),ctx);const U=ctx.FleetServiceUI;
assert.deepEqual(Array.from(U.pdfQueries('plate','ΒΤΟ 756')),['BTO756']);assert.ok(U.pdfQueries('invoiceDate','2026-10-11').includes('11102026'));assert.ok(U.pdfQueries('totalAmount','59').includes('5900'));
assert.equal(fs.readFileSync('cloudflare-worker/public/vendor/pdfjs/pdf.mjs','utf8'),fs.readFileSync('cloudflare-worker/node_modules/pdfjs-dist/legacy/build/pdf.mjs','utf8'));
console.log('OK pinned PDF.js: actual two-page PDF parsing, text coordinates, Greek/Latin plate, date and amount query variants, loading-task cleanup and matching bundled bytes.');
