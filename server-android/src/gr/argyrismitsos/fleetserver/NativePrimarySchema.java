package gr.argyrismitsos.fleetserver;

/** Shared durable phases; these rows never substitute for a live authority lease. */
public final class NativePrimarySchema {
    public static final String STATE="CREATE TABLE IF NOT EXISTS native_primary_state(id INTEGER PRIMARY KEY CHECK(id=1),phase TEXT NOT NULL,realm TEXT NOT NULL,generation TEXT NOT NULL DEFAULT '',owner_id TEXT NOT NULL DEFAULT '',data_hash TEXT NOT NULL DEFAULT '',imported_at TEXT NOT NULL DEFAULT '',proof_sha TEXT NOT NULL DEFAULT '',source_revision TEXT NOT NULL DEFAULT '');";
    private NativePrimarySchema(){}
}
