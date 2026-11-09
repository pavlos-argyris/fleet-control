import {businessPort,businessContext} from './ports.js';
import {cashProjection} from './cash.js';
import {storeReport} from './reports.js';
import {actor,range,text,NativeError} from './common.js';
const col=(label,type='text',width=100)=>({label,type,width});
const coverage=value=>value?'Πλήρη στοιχεία':'Ελλιπή στοιχεία - δεν είναι τελικό σύνολο';
const cell=value=>value===undefined?null:value;
export function cashExportSpec(result,table='couriers'){
  const summary={name:'Ανά διανομέα',columns:[col('Διανομέας','text',245),col('Παραγγελίες','integer',95),col('Προς απόδοση','money',145),col('Παραδόθηκαν','money',145),col('Υπόλοιπο','money',145)],rows:result.couriers.map(r=>[r.courierName,r.orders,r.dueCents,r.receivedCents,r.balanceCents])};
  const labels={assessment:'Οφειλή',receipt:'Παραλαβή',reversal:'Αντιλογισμός'};
  const movements={name:'Κινήσεις',columns:[col('Ημέρα','text',80),col('Διανομέας','text',125),col('Κίνηση','text',90),col('Κατάστημα / κατηγορία','text',165),col('Ποσότητα','integer',65),col('Ποσό','money',90),col('Αιτιολογία','text',165)],rows:result.events.map(e=>[e.business_day,e.courier_name,labels[e.kind],e.store_id+(e.category?' / '+e.category:''),e.quantity,e.amount_cents*(e.kind==='reversal'?-1:1),e.notes])};
  const details={name:'Ανάλυση',columns:[col('Διανομέας','text',210),col('Κατάστημα','text',210),col('Κατηγορία','text',90),col('Παραγγελίες','integer',100),col('Προς απόδοση','money',160)],rows:result.couriers.flatMap(r=>r.breakdown.map(b=>[r.courierName,b.storeId,b.category,b.orders,b.dueCents]))};
  return{title:'Ταμείο διανομέων',subtitle:result.from+' έως '+result.to+' | Ημέρα 05:00-05:00 Europe/Athens | Επιβεβαιωμένες χειροκίνητες καταχωρίσεις | Ανεξάρτητο από μισθοδοσία',tables:table==='events'?[movements,summary,details]:[summary,details]};
}
export function storeExportSpec(result){
  const columns=[col('Περίοδος','text',85),col('Κατάστημα','text',190),col('Παραγγελίες','integer',80),col('Χρέωση παραγγελιών','money',110),col('Συμπλήρωμα παγίου','money',110),col('Τελικό ποσό','money',100),col('Κάλυψη','text',170)];
  const groups={name:'Οικονομικά',columns,rows:result.groups.map(r=>[r.period,r.storeName,cell(r.orderCount),cell(r.orderChargeCents),cell(r.minimumTopUpCents),cell(r.totalChargeCents),coverage(r.coverageVerified)])};
  const daily={name:'Ανά ημέρα',columns,rows:result.daily.map(r=>[r.day,r.storeName,cell(r.orderCount),cell(r.orderChargeCents),cell(r.minimumTopUpCents),cell(r.totalChargeCents),r.reason||'Πλήρης ανάγνωση'+(r.published?'':' - εκκρεμεί διανομή')])};
  const notes={name:'Στοιχεία αναφοράς',columns:[col('Στοιχείο','text',220),col('Τιμή','text',550)],rows:[['Από',result.from],['Έως',result.to],['Ημέρα','05:00-05:00 Europe/Athens'],['Κάλυψη',coverage(result.coverageVerified)],['Παρατήρηση','Η απουσία δεδομένων εμφανίζεται ως Άγνωστο. Οι αποθηκευμένες ιστορικές τιμές δεν αντικαθίστανται.'],['Χρόνος αναφοράς',result.observedAt]]};
  return{title:'Οικονομικά καταστημάτων',subtitle:result.from+' έως '+result.to+' | Ημέρα 05:00-05:00 Europe/Athens | '+coverage(result.coverageVerified)+' | '+result.observedAt,tables:[groups,daily,notes]};
}
export async function routeExports(request,env){
  const url=new URL(request.url);if(!['/api/native/cash/export','/api/native/store-financials/export'].includes(url.pathname))return null;
  if(request.method!=='GET')throw new NativeError(405,'Η εξαγωγή γίνεται από την αντίστοιχη αναφορά.');
  const cash=url.pathname.includes('/cash/');await actor(request,env,cash?'cash.view':'stores.view');const {from,to}=range(url);
  const format=url.searchParams.get('format');if(!['xlsx','pdf'].includes(format))throw new NativeError(400,'Επίλεξε Excel ή PDF.');
  let spec;
  if(cash){const table=url.searchParams.get('table'),result=await cashProjection(env,from,to,text(url.searchParams.get('courierId'),100),{eventLimit:table==='events'?5001:0});if(table==='events'&&result.eventCount>5000)throw new NativeError(413,'Για αναλυτικές κινήσεις επίλεξε έως 5.000 εγγραφές ανά εξαγωγή. Η συγκεντρωτική αναφορά καλύπτει όλο το διάστημα.');spec=cashExportSpec(result,table);}
  else{const scope=businessContext(env);if(!scope.configured)throw new NativeError(503,'Χρειάζεται ρύθμιση καταστημάτων στον Server.');if(url.searchParams.has('scope')&&url.searchParams.get('scope')!==scope.scope)throw new NativeError(409,'Άλλαξε η πηγή της αναφοράς.');spec=storeExportSpec(await storeReport(env,{from,to,period:url.searchParams.get('period')||'day',scope:scope.scope,storeId:text(url.searchParams.get('storeId'),200)}));}
  const exported=await businessPort(env,'reports.export',{format,spec});
  const file=env.BUSINESS_PORT?exported:new File(exported);
  return new Response(file,{headers:{'Content-Type':format==='pdf'?'application/pdf':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="Fleet_'+(cash?'Cash':'Stores')+'_'+from+'_'+to+'.'+format+'"','Cache-Control':'private, no-store'}});
}
