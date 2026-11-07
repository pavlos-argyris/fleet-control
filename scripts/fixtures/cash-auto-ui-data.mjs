/** Synthetic presentation state only; financial invariants use actual native/SQLite suites. */
export function automaticCashUiData(day,scope){return{
 overview:{scope,days:[{day,state:'manual-review',source_complete_at:'2026-11-06T16:00:00Z',issues:[]}],exclusions:[{id:'exclude-one',order_id:'991',business_day:day,store_id:'shop-a',revision:3,notes:'Συνθετική χειροκίνητη εξαίρεση <img src=x>'}]},
 preview:{scope,day,state:'manual-review',proof:'preview-one',issues:[],manualEvents:[{amount_cents:1500}],forecast:[{quantity:4,amountCents:1000}]}
};}
