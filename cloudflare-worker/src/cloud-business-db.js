/** D1-shaped adapter on Cloudflare-owned SQLite. The caller encloses the full
 * business handler, audit and receipt in storage.transaction(), never just a
 * subset of its SQL. There is no global DB or native host. */
export function cloudBusinessDatabase(storage){
  const execute=(query,params=[])=>{
    const cursor=storage.sql.exec(query,...params);
    const results=Array.from(cursor);
    const change=/^\s*(SELECT|EXPLAIN)\b/i.test(query)?{changes:0,last_row_id:0}:Array.from(storage.sql.exec('SELECT changes() changes,last_insert_rowid() last_row_id'))[0];
    return {success:true,results,meta:{changes:change.changes,last_row_id:change.last_row_id,rows_read:cursor.rowsRead||0,rows_written:cursor.rowsWritten||0}};
  };
  const prepare=(query,params=[])=>({
    query,params,bind(...values){return prepare(query,values);},
    async all(){return execute(query,params);},
    async first(column){const first=execute(query,params).results[0]||null;return column===undefined?first:first?.[column]??null;},
    async run(){return execute(query,params);},
    async raw(){return Array.from(storage.sql.exec(query,...params).raw());}
  });
  const database={prepare,withSession(){return this;},getBookmark(){return null;},
    async exec(sql){execute(sql);return{count:0,duration:0};},
    async batch(queries){return storage.transactionSync(()=>queries.map(q=>execute(q.query,q.params)));}
  };
  return database;
}

/** 5xx or thrown failures roll back the complete operation. Like native runtime,
 * 4xx can retain auth throttling and explicitly acknowledged safe bookkeeping. */
export async function cloudBusinessTransaction(storage,dispatch){
  let rollbackResponse;
  try{
    return await storage.transaction(async()=>{
      const response=await dispatch();
      if(response.status>=500){rollbackResponse=response;throw Error('business-response-rollback');}
      return response;
    });
  }catch(error){if(rollbackResponse)return rollbackResponse;throw error;}
}
