const native=globalThis.FleetHost;
function prepared(sql,params=[]){
  return {
    sql,params,bind(...values){return prepared(sql,values);},
    async first(column){const value=native('sql.query',{sql,params,first:true}).results[0]||null;return column===undefined?value:value?.[column]??null;},
    async all(){return native('sql.query',{sql,params});},
    async run(){return native('sql.run',{sql,params});},
    async raw(){return native('sql.raw',{sql,params}).rows;}
  };
}
export const DB={
  prepare:prepared,withSession(){return this;},getBookmark(){return null;},
  async batch(queries){return native('sql.batch',{queries:queries.map(q=>({sql:q.sql,params:q.params}))}).results;},
  async exec(sql){return native('sql.exec',{sql});}
};
