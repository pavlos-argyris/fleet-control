// Pure, read-only projection. All amounts are integer cents, independent from wages.
// Neither this module nor its tests read/write Ordexa or Fleet production tables.
const assertId=(value,label)=>{
 if(typeof value!=='string'||!value.trim()||value.length>180)throw new TypeError('Invalid '+label);
 return value;
};
const assertDay=(value,label='day')=>{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value)throw new TypeError('Invalid '+label);
 return value;
};
const cents=(value,label)=>{if(!Number.isSafeInteger(value)||value<0||value>10000000000)throw new TypeError('Invalid '+label);return value;};
const seenUnique=(map,item,label)=>{
 const id=assertId(item?.id,label+' id'),value=JSON.stringify(item);
 if(map.has(id)){if(map.get(id)!==value)throw new Error('Conflicting '+label+' '+id);return false;}
 map.set(id,value);return true;
};
const safeAdd=(a,b)=>{const sum=a+b;if(!Number.isSafeInteger(sum))throw new RangeError('Cash total overflow');return sum;};
export function projectCourierCash({day,orders=[],tariffs=[],receipts=[]}={}){
 assertDay(day);
 for(const [name,value] of Object.entries({orders,tariffs,receipts}))if(!Array.isArray(value))throw new TypeError(name+' must be array');
 const allTariffs=new Map();
 for(const tariff of tariffs){
  const storeId=assertId(tariff?.storeId,'tariff store'),category=assertId(tariff?.category,'tariff category'),effectiveDay=assertDay(tariff?.effectiveDay,'tariff effectiveDay');
  const priceCents=cents(tariff?.amountCents,'tariff amountCents'),key=JSON.stringify([storeId,category]);
  if(!allTariffs.has(key))allTariffs.set(key,[]);
  const list=allTariffs.get(key);
  if(list.some(t=>t.effectiveDay===effectiveDay))throw new Error('Ambiguous tariff effectiveDay for '+storeId+'/'+category);
  list.push({effectiveDay,priceCents});
 }
 for(const list of allTariffs.values())list.sort((a,b)=>a.effectiveDay.localeCompare(b.effectiveDay));
 const couriers=new Map(),issues=[],seenOrders=new Map(),seenReceipts=new Map();
 function person(id){if(!couriers.has(id))couriers.set(id,{courierId:id,orders:0,dueCents:0,receivedCents:0,missingTariffs:0,stores:{}});return couriers.get(id);}
 for(const order of orders){
  if(!seenUnique(seenOrders,order,'order'))continue;
  const id=order.id,orderDay=assertDay(order.day,'order day');
  if(orderDay!==day)continue;
  if(!['delivered','cancelled','deleted'].includes(order.status))throw new TypeError('Invalid order status '+id);
  if(order.status!=='delivered')continue;
  const storeId=assertId(order.storeId,'store id'),category=assertId(order.category,'category');
  const idCourier=order.courierId;
  if(typeof idCourier!=='string'||!idCourier.trim()){issues.push({type:'missing-courier',orderId:id});continue;}
  assertId(idCourier,'courier id');
  const p=person(idCourier);
  const rate=(allTariffs.get(JSON.stringify([storeId,category]))||[]).filter(t=>t.effectiveDay<=orderDay).at(-1);
  if(!rate){p.missingTariffs++;issues.push({type:'missing-tariff',orderId:id,courierId:idCourier,storeId,category});continue;}
  p.orders++;p.dueCents=safeAdd(p.dueCents,rate.priceCents);
  const key=JSON.stringify([storeId,category]),entry=p.stores[key]||{storeId,category,orders:0,dueCents:0};
  entry.orders++;entry.dueCents=safeAdd(entry.dueCents,rate.priceCents);p.stores[key]=entry;
 }
 for(const receipt of receipts){
  if(!seenUnique(seenReceipts,receipt,'receipt'))continue;
  const rday=assertDay(receipt.day,'receipt day');if(rday!==day)continue;
  const idCourier=assertId(receipt.courierId,'receipt courier');
  const amount=cents(receipt.amountCents,'receipt amountCents');
  if(!['received','reversal'].includes(receipt.kind))throw new TypeError('Invalid receipt kind');
  const p=person(idCourier);p.receivedCents=safeAdd(p.receivedCents,receipt.kind==='received'?amount:-amount);
 }
 const list=[...couriers.values()].sort((a,b)=>a.courierId.localeCompare(b.courierId)).map(p=>({
  ...p,breakdown:Object.values(p.stores).sort((a,b)=>(a.storeId+a.category).localeCompare(b.storeId+b.category)),
  dueCents:p.missingTariffs?null:p.dueCents,
  differenceCents:p.missingTariffs?null:p.dueCents-p.receivedCents,
  complete:p.missingTariffs===0,
  stores:undefined
 }));
 return {day,couriers:list,issues,complete:issues.length===0};
}
