// Entirely synthetic. No customer, supplier, tax ID or production PDF data.
export function invoiceText({count=4, plate='ΒΤΟ 756',km='9000',number='ΤΔΑ0000123',date='28/10/2026',net='100,00',vat='24,00',total='124,00',pageSize=20}={}) {
  const lines=['ΣΥΝΘΕΤΙΚΟ ΣΥΝΕΡΓΕΙΟ','Είδος Παραστατικού Αριθμός Ημερομηνία Έκδοσης',`Τιμολόγιο ${number} ${date}`,'Κωδικός Περιγραφή Ποσότητα Τιμή Αξία'];
  for(let i=1;i<=count;i++) {
    if(i>1 && (i-1)%pageSize===0)lines.push(`Σελίδα ${Math.ceil(i/pageSize)}`, 'Κωδικός Περιγραφή Ποσότητα Τιμή Αξία');
    lines.push(`L${String(i).padStart(10,'0')} Εργασία ${i} 1,00 Τεμάχια 8,07`);
    if(i===2)lines.push('Συνέχεια περιγραφής ανταλλακτικού');
  }
  lines.push('Εκπτώσεις/Χρεώσεις',`Σύνολο Καθαρού Ποσού ${net}`,`Σύνολο Φ.Π.Α ${vat}`,`Συνολική Αξία ${total}`,`Σύνολο γραμμών ${count}`,'Όροι Πληρωμής Συναλλαγής Τοίς Μετρητοίς','Σχόλια',plate,String(km),'Μ.Αρ.Κ. 999999999999999');
  return lines.join('\n');
}
