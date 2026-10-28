// Rules for the labelled Impact/eInvoicing text layout. AI scores are never
// evidence for confirmation. Run these rules on the actual PDF/DOM text.
export const INVOICE_RULES_VERSION = 'invoice-layout-v1';
export const MAX_INVOICE_TEXT = 128000;
export const MAX_INVOICE_ITEMS = 512;
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const unique = values => [...new Set(values.filter(value=>value!==undefined&&value!==null&&value!==''))];
const plainRow = row => row.includes('|')?row.replaceAll('|',' ').replace(/\s+/g,' ').trim():row;
const plateLetters = 'ABEZHIKMNOPTYXΑΒΕΖΗΙΚΜΝΟΡΤΥΧ';
const platePattern = `(?<![A-ZΑ-Ω0-9])([${plateLetters}]{3})[ \\t-]*(\\d{3,4})(?![A-ZΑ-Ω0-9])`;
export function invoicePlate(value) {
  const greek = 'ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ', latin = 'ABEZHIKMNOPTYX';
  const compact = String(value || '').toUpperCase().replace(/[\s-]/g, '').replace(/[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/g, c => latin[greek.indexOf(c)]);
  return /^[ABEZHIKMNOPTYX]{3}\d{3,4}$/.test(compact) ? compact : '';
}
export function invoiceCents(value) {
  let text = String(value ?? '').replace(/(?:EUR|€|\s)/gi, '');
  if (!/^-?\d+(?:[.,]\d+)*$/.test(text)) return null;
  const pos = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
  if (pos >= 0) {
    const decimal = text[pos], other = decimal === '.' ? ',' : '.';
    if (text.length - pos - 1 !== 2 || text.indexOf(decimal) !== pos) return null;
    const whole = text.slice(0, pos);
    if (whole.includes(other) && !new RegExp(`^-?\\d{1,3}(?:\\${other}\\d{3})*$`).test(whole)) return null;
    text = whole.split(other).join('') + '.' + text.slice(pos + 1);
  }
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
function isoDate(value) {
  let s = String(value || ''), m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if (m) s = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const date = new Date(s + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s ? s : '';
}
const dateTokens = text => [...text.matchAll(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4})\b/g)].map(m => isoDate(m[0]));
const moneyToken = '-?\\d+(?:[.,]\\d{3})*[.,]\\d{2}';
const itemCode = /^(?:\d{1,3}\s+)?((?=[A-ZΑ-Ω0-9_\-/]*\d)[A-ZΑ-Ω0-9_\-/]{3,})\s+(.+)$/i;
const moneyColumns = new RegExp(`\\s+${moneyToken}(?:\\s|$).*$`);
const sectionEnd = /^(?:εκπτωσεις\s*\/\s*χρεωσεις|αναλυση\s+φ\.?\s*π\.?\s*α|συνολο|συνολικη\s+αξια|γενικο\s+συνολο|καθαρη\s+αξια|πληρωτεο|subtotal|total|net\s+amount|στοιχεια\s+πληρωμης|σχολια|οροι\s+πληρωμης)/;
const pageHeader = /^(?:σελιδα\s+\d|page\s+\d|μεταφορα\s+(?:απο|σε)|εκ\s+μεταφορας|συνεχεια\s+(?:απο|σε))/;
const tableHeader = /(?:κωδικος.*περιγραφη|περιγραφη.*ποσοτητα|description.*(?:quantity|qty)|code.*description)/;

export function parseInvoiceText(value) {
  const original = String(value || '');
  const text = original.slice(0, MAX_INVOICE_TEXT).replace(/\r\n?/g, '\n').replace(/\u0000/g, ' ').replace(/[\t\u00a0]+/g, ' ');
  const rows = text.split('\n').map(s => s.replace(/^\s*[#>*]+\s*/, '').trim()).filter(Boolean);
  const found = {}, problems = [], fields = {};
  const issue = (field, code, message) => { if (!problems.some(p => p.field === field && p.code === code)) problems.push({field, code, message}); };
  const accept = (field, candidates, evidence, comparable = v => v) => {
    const values = unique(candidates), keys = unique(values.map(comparable));
    if (keys.length === 1) { found[field] = values[0]; fields[field] = {score: 95, source: 'labelled-text', reason: 'Μοναδική τιμή στο σχετικό πεδίο του εγγράφου', evidence: String(evidence || '').slice(0, 500)}; }
    else if (keys.length > 1) issue(field, 'conflicting-values', 'Το έγγραφο περιέχει διαφορετικές τιμές για το ίδιο πεδίο.');
  };
  if (!text.trim() || /^\s*[\[{]/.test(text)) return {data: {}, fields: {}, problems: [{field:'document',code:'no-document-text',message:'Δεν υπάρχει ανεξάρτητο αναγνώσιμο κείμενο του εγγράφου.'}], completeTable:false, rowCount:0, version:INVOICE_RULES_VERSION};
  if (original.length > MAX_INVOICE_TEXT) issue('document', 'text-limit', 'Το κείμενο υπερβαίνει το όριο ανάγνωσης· χρειάζεται έλεγχος του πλήρους PDF.');
  const plates = [], kms = [], comments = [], dates = [], dateEvidence = [], declaredCounts = [], numbers = [], suppliers = [], money = {netAmount:[],vatAmount:[],totalAmount:[]};
  for (let i = 0; i < rows.length; i++) {
    // Label/date/money rules do not apply to item-code rows. Avoid repeated
    // Unicode normalization and header regexes for hundreds of invoice items.
    const row = plainRow(rows[i]);
    if(itemCode.test(row))continue;
    const label = fold(row);
    const declaredCount=label.match(/^(?:συνολο\s+γραμμων|πληθος\s+(?:γραμμων|ειδων)|total\s+lines)\s*:?\s*(\d+)$/);
    if(declaredCount)declaredCounts.push(Number(declaredCount[1]));
    const supplierLabel=label.match(/^(?:προμηθευτης|εκδοτης|επωνυμια\s+εκδοτη|supplier)\s*:\s*/);
    if(supplierLabel){const name=row.slice(supplierLabel[0].length).trim();if(name.length>2&&name.length<=240)suppliers.push(name);}
    if (/^σχολια(?=\s|:|$)/.test(label)) {
      let comment = row.replace(/^[^:]*?:\s*/, '');
      if (comment === row) comment = row.replace(/^σχ[όο]λια\s*/i, '');
      for (let j = i + 1; j < rows.length && j <= i + 5; j++) {
        const next = plainRow(rows[j]), n = fold(next);
        if (/^(?:μ\.?\s*αρ\.?\s*κ|mark|υπογραφ|https?:|στοιχεια|αδειοδοτ|συνολ|καθαρη|φ\.?π\.?α)/.test(n) || tableHeader.test(n)) break;
        comment += ' ' + next;
      }
      comments.push(comment.trim());
      const matches = [...comment.toUpperCase().matchAll(new RegExp(platePattern, 'g'))];
      for (const m of matches) {
        plates.push(invoicePlate(m[1]+m[2]));
        const tail = comment.slice(m.index + m[0].length).trim();
        const km = tail.match(/^(?:(?:χλμ\.?|χιλι[όο]μετρα|km)\s*:?\s*)?(\d{1,3}(?:[ .]\d{3})+|\d{1,10})\s*(?:(?:χλμ\.?|km)\b)?/i);
        if (km) {
          const digits = km[1].replace(/\D/g, '');
          if (Number.isSafeInteger(Number(digits)) && Number(digits) <= 2000000000) kms.push(String(Number(digits)));
          if (/\d/.test(tail.slice(km[0].length))) issue('odometerKm','ambiguous-comments','Υπάρχουν επιπλέον αριθμοί μετά τα χιλιόμετρα στα Σχόλια.');
        }
      }
    }
    if (/^(?:πινακιδα|αρ\.?\s*κυκλ|αριθμος\s+κυκλοφοριας|plate|registration)(?=\s|:|$)/.test(label)) {
      for (const m of (row+' '+(rows[i+1] || '')).toUpperCase().matchAll(new RegExp(platePattern,'g'))) plates.push(invoicePlate(m[1]+m[2]));
    }
    if (/^(?:χιλιομετρα|χλμ\.?|odometer|mileage|km)(?=\s|:|$)/.test(label)) {
      const v = row.replace(/^[^\d]+/, '').trim();
      if (/^(?:\d{1,10}|\d{1,3}(?:[ .]\d{3})+)\s*(?:χλμ\.?|km)?$/i.test(v)) kms.push(String(Number(v.replace(/\D/g,''))));
    }
    if (/(?:ημερομηνια\s+εκδοσης|issue\s+date|invoice\s+date)/.test(label)) {
      dateEvidence.push(row);
      const own = dateTokens(row); dates.push(...own);
      if (!own.length && rows[i+1]) dates.push(...dateTokens(rows[i+1]));
      if (/\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}/.test(row) && own.some(v=>!v)) issue('invoiceDate','invalid-date','Η ημερομηνία έκδοσης δεν είναι έγκυρη.');
    }
    if (/^(?:αριθμος\s+(?:τιμολογιου|παραστατικου)|αρ\.?\s*τιμολογιου|invoice\s+(?:no\.?|number))(?=\s|:|$)/.test(label)) {
      const tail = row.replace(/^(?:αριθμ[όο]ς\s+(?:τιμολογ[ίι]ου|παραστατικο[ύυ])|αρ\.?\s*τιμολογ[ίι]ου|invoice\s+(?:no\.?|number))\s*[:#]?\s*/i, '').trim();
      const token = tail || plainRow(rows[i+1] || '');
      if (/^[A-ZΑ-Ω0-9][A-ZΑ-Ω0-9\-/]{1,79}$/i.test(token) && /\d/.test(token)) numbers.push(token.toUpperCase());
    }
    if (/(?:ειδος\s+παραστατικου|αριθμος.*ημερομηνια\s+εκδοσης)/.test(label)) {
      for (const next of rows.slice(i+1,i+4)) {
        if (tableHeader.test(fold(next))) break;
        const m = next.match(/(?:τιμολ[όο]γιο\s+)?(?<![A-ZΑ-Ω0-9])((?:ΤΔΑ|ΤΙΜ|ΑΠΥ|INV)[A-ZΑ-Ω0-9\-/]*\d[A-ZΑ-Ω0-9\-/]*)(?![A-ZΑ-Ω0-9])/i);
        if (m) numbers.push(m[1].toUpperCase());
      }
    }
    for (const [field, pattern] of [['netAmount',/^(?:συνολο\s+καθαρου\s+ποσου|καθαρη\s+αξια|αξια\s+προ\s+φπα|net\s+amount)\s*:?\s*/],['vatAmount',/^(?:συνολο\s+φ\.?\s*π\.?\s*α\.?|ποσο\s+φπα|φπα|vat\s+amount)\s*:?\s*/],['totalAmount',/^(?:συνολικη\s+αξια|γενικο\s+συνολο|πληρωτεο\s+ποσο|grand\s+total|total\s+amount)\s*:?\s*/]]) {
      const match = label.match(pattern);
      if (!match) continue;
      const tail = label.slice(match[0].length).trim() || rows[i+1] || '';
      const m = tail.match(new RegExp(`^(${moneyToken})\\s*(?:€|eur)?$`, 'i'));
      if (m && invoiceCents(m[1]) !== null) money[field].push(m[1]);
    }
  }
  accept('plate', plates, comments.join('\n'), invoicePlate);
  if (found.plate) found.plate = found.plate.slice(0,3)+'-'+found.plate.slice(3);
  accept('odometerKm', kms, comments.join('\n'));
  accept('invoiceDate', dates, dateEvidence.join('\n'));
  accept('invoiceNumber', numbers, numbers.join(' / '));
  accept('supplier', suppliers, suppliers.join(' / '));
  for (const field of Object.keys(money)) accept(field,money[field],money[field].join(' / '),invoiceCents);
  if (comments.length) found.comments = unique(comments).join('\n').slice(0,2000);
  const items = []; let table = false, seenTable = false, ended = false, current = '', count = 0;
  const flush = () => { if (current.trim()) { items.push(current.trim()); current = ''; } };
  for (const raw of rows) {
    const cells = raw.split('|').map(v=>v.trim()).filter(Boolean);
    const row = cells.join(' ').replace(/\s+/g,' ').trim(), code = itemCode.exec(row), lower = code?'':fold(row);
    if (tableHeader.test(lower)) { seenTable=true;table=true;continue; }
    if (/^[-:| ]+$/.test(raw) || pageHeader.test(lower)) continue;
    if (sectionEnd.test(lower)) { if (table) {flush();ended=true;} table=false;continue; }
    if (!table) continue;
    const described = /^(?:λαδι|λαδια|oil|φιλτρ|εργασ|service|αλλαγ|ανταλλακ|τακακ|αλυσιδ|μπουζ|ελαστικ|επισκευ)/.test(lower);
    let description = code ? code[2] : row;
    // Quantity starts the numeric columns. Codes and prices are not tasks.
    description = description.replace(/\s+\d+(?:[.,]\d{1,3})?\s+(?:τεμαχια|τεμάχια|h87|pcs?|ωρες|ώρες)(?=\s|$).*$/i, '').replace(moneyColumns,'').trim();
    if (code || described || (cells.length >= 3 && /\d/.test(cells.at(-1)))) {
      flush(); count++; ended=false;
      if (!description || description.length > 500 || !/[A-ZΑ-Ω]/i.test(description)) issue('lineItems','invalid-row','Μια περιγραφή είναι κενή, ασαφής ή υπερβολικά μεγάλη.');
      current=description.slice(0,500);
    } else if (current && /[A-ZΑ-Ω]/i.test(description) && !/(?:αφμ|τηλεφωνο|διευθυνση|τιμολογιο|παραστατικο|ημερομηνια)/.test(lower)) {
      if(!/^(?:συνεχεια\s+περιγραφης|yamalube|crypton|federal|mhq|\d{1,3}[a-z/\d\-])/.test(lower))issue('lineItems','uncertain-row-boundary','Μια γραμμή μπορεί να είναι συνέχεια περιγραφής ή διαφορετικό είδος· χρειάζεται έλεγχος του πίνακα.');
      if (current.length + description.length + 1 > 500) issue('lineItems','long-row','Η περιγραφή μιας γραμμής υπερβαίνει το όριο.');
      current=(current+' '+description).slice(0,500);
    } else if (!/^\d+(?:[.,\s]\d+)*$/.test(row)) issue('lineItems','unparsed-row','Μια γραμμή του πίνακα δεν αναγνωρίστηκε με βεβαιότητα.');
    if (count > MAX_INVOICE_ITEMS) { issue('lineItems','item-limit','Το παραστατικό υπερβαίνει τις 512 γραμμές· απαιτείται έλεγχος.'); break; }
  }
  flush();
  const declared = unique(declaredCounts);
  if (declared.length && (declared.length!==1 || declared[0]!==count)) issue('lineItems','row-count','Το πλήθος γραμμών δεν συμφωνεί με την ένδειξη του εγγράφου.');
  const completeTable = seenTable && ended && count > 0 && count === items.length && !problems.some(p=>['lineItems','document'].includes(p.field));
  if (!completeTable) issue('lineItems','incomplete-table','Δεν τεκμηριώθηκε η πλήρης ανάγνωση του πίνακα εργασιών/ανταλλακτικών.');
  if (items.length) { found.lineItems=items.slice(0,MAX_INVOICE_ITEMS);found.workPerformed=found.lineItems.join('\n'); }
  fields.lineItems={score:completeTable?95:40,source:'labelled-table',reason:completeTable?`Διαβάστηκαν όλες οι ${count} γραμμές του πίνακα`:'Χρειάζεται έλεγχος πληρότητας πίνακα',evidence:`${count} γραμμές${declared.length?', δηλωμένες '+declared.join('/') : ''}`};
  return {data:found, fields, problems, completeTable, rowCount:count, version:INVOICE_RULES_VERSION};
}

export function enrichInvoiceExtraction(value, proof) {
  if (!value || typeof value !== 'object') return value;
  const parsed = proof || parseInvoiceText(value.rawText);
  const data = {...value, ...parsed.data};
  if(parsed.completeTable)data.parts=[];
  // Deterministic conflicts must never be hidden by an AI's single answer.
  for (const problem of parsed.problems) if (problem.code==='conflicting-values') delete data[problem.field];
  data.extractionChecks={version:parsed.version,completeTable:parsed.completeTable,rowCount:parsed.rowCount,problems:parsed.problems};
  data.fieldEvidence={...value.fieldEvidence,...parsed.fields};
  return data;
}

export function evaluateInvoiceConfirmation(data, {bike, entry, bikes, previous = {}, readError = '', proof:providedProof}) {
  const reasons = [];
  const add=(field,code,message)=>{if(!reasons.some(r=>r.field===field&&r.code===code))reasons.push({field,code,message});};
  // Recompute proof rather than accepting a previously stored/AI supplied flag.
  const proof=providedProof||parseInvoiceText(data?.rawText), actual=proof.data;
  for(const p of proof.problems)add(p.field,p.code,p.message);
  for(const field of ['plate','odometerKm','invoiceNumber','invoiceDate','netAmount','vatAmount','totalAmount']) {
    if(!actual[field])add(field,'missing-evidence','Λείπει σαφής τιμή από το αντίστοιχο πεδίο του εγγράφου.');
    const normalize=field==='plate'?invoicePlate:/Amount$/.test(field)?invoiceCents: v=>String(v??'').trim();
    if(actual[field] && normalize(data?.[field])!==normalize(actual[field]))add(field,'source-disagreement','Η αποθηκευμένη τιμή διαφέρει από το τεκμήριο του εγγράφου.');
  }
  const plate=invoicePlate(data?.plate),matches=(bikes||[]).filter(b=>invoicePlate(b.name)===plate);
  if(!data?.supplier&&!data?.qrUrl)add('invoiceNumber','issuer-identity','Λείπει η ταυτότητα εκδότη ή η μοναδική πηγή QR για έλεγχο διπλοτύπου.');
  if(!plate||plate!==invoicePlate(bike?.name)||matches.length!==1||String(matches[0].id)!==String(bike?.id))add('plate','vehicle-match','Δεν υπάρχει μοναδική συμφωνία με το συνδεδεμένο μηχανάκι.');
  if(!/^\d{1,10}$/.test(String(data?.odometerKm||''))||Number(data.odometerKm)>2000000000||Number(data.odometerKm)!==Number(entry?.km))add('odometerKm','service-mileage','Τα χιλιόμετρα απαιτούν έλεγχο ή ρητή απόφαση χρήστη.');
  const net=invoiceCents(data?.netAmount),vat=invoiceCents(data?.vatAmount),gross=invoiceCents(data?.totalAmount);
  if(net===null||vat===null||gross===null||net<0||vat<0||gross<=0||Math.abs(net+vat-gross)>1)add('totalAmount','amounts','Καθαρή αξία, ΦΠΑ και σύνολο δεν συμφωνούν.');
  if(!proof.completeTable||JSON.stringify(data?.lineItems||[])!==JSON.stringify(actual.lineItems||[]))add('lineItems','stored-lines','Οι αποθηκευμένες γραμμές δεν συμφωνούν με τον πλήρη πίνακα.');
  if(readError||data?.ocrFallbackError||data?.textTruncated===true)add('document','read-error','Η τελευταία ανάγνωση δεν ολοκληρώθηκε επιτυχώς.');
  if(data?.localReadStatus==='ambiguous'||/διαφων|conflict|truncat|όριο|οριο/i.test(String(data?.ocrFallbackReason||'')))add('document','source-conflict','Η ανάγνωση αναφέρει αβεβαιότητα, διαφωνία πηγών ή όριο.');
  if(previous?.correctedByUserAt||previous?.mileageResolution||previous?.plateResolution)add('document','user-decision','Διατηρείται η προηγούμενη ρητή απόφαση χρήστη.');
  if(data?.plateAutoCorrectedFrom)add('plate','ocr-correction','Η πινακίδα διορθώθηκε με ανοχή OCR και απαιτεί επιβεβαίωση.');
  const fields=['plate','odometerKm','invoiceNumber','invoiceDate','netAmount','vatAmount','totalAmount','lineItems'];
  const score=Math.round(fields.reduce((sum,f)=>sum+(actual[f]&& !reasons.some(r=>r.field===f)?95:0),0)/fields.length);
  return {version:INVOICE_RULES_VERSION,eligible:reasons.length===0,reasons,score,rowCount:proof.rowCount};
}
