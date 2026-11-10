/** The JSON lookup is used only by automatic cash source reconciliation.
 * Raw store orders must not pay for an unrelated JSON index on every write.
 * Index replacement changes no canonical rows, history or audit records. */
export function ensureCloudStoreIndexes(sql){
 sql.exec('CREATE INDEX IF NOT EXISTS cloud_store_source ON store_billing_local(scope,kind,day,store_id)');
 sql.exec("CREATE INDEX IF NOT EXISTS cloud_cash_order_identity_v2 ON store_billing_local(scope,json_extract(data,'$.sourceOrderId')) WHERE kind='cash_snapshot_order'");
 sql.exec('DROP INDEX IF EXISTS cloud_store_order_identity');
}
