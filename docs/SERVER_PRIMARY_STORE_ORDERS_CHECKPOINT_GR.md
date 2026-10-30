# Server-primary Ordexa store orders — implementation checkpoint (31/10/2026)

User approved implementation: Android Server SQLite is the authoritative store-order database; Cloudflare is a periodic sync/backup and compact published-results layer, not the raw-order ingestion database.

## Verified baseline
- Issue #51 documents StoreBillingSync tick every 2s, day-overlap reads, two consistent scans, D1 raw archive pages of 32 and D1 mirror/index writes. Do not attribute all D1 usage to orders: pulse/heartbeat is also a confirmed contributor.
- Issue #52's direct access implementation has separate status and must not be overwritten.
- Issue #44 preserves 05:00 Europe/Athens business days and per-store keep-deleted switch (default OFF).

## Implementation requirements
1. Preserve existing D1 records and deployed behavior until tested migration/dual-read rollout; no destructive schema migration.
2. Add durable SQLite authoritative order ledger, transactional import and versioned aggregate snapshots. Persist outbox batches and receipts, with idempotency, retries and CAS/epoch protection. Locally completed import must not depend on D1 availability.
3. Publish only changed aggregate snapshots and metadata to D1, not individual order archive rows. For backups, evaluate existing R2/backup path and quotas; encrypt and validate restorable snapshots, with retention, checksums and restore drills. Do not assume R2 writes are free or zero-cost.
4. Read views from last confirmed aggregate; show freshness, queued publish state, and offline behavior. Preserve independent pricing edits and audited overrides.
5. Preserve safe deletion reconciliation only after complete consistent source scan, timezone/DST and store identity invariants.
6. Profile actual D1 reads/writes, pulse, SQL, provider I/O and latency before/after; tests 1/7/31 days, repeated sync, interrupted upload, restart, restore and concurrent edits.
7. Keep Ordexa strictly read-only; do not change production or publish before full checks and signed artifact verification.

## Work status
This branch and checkpoint have been created. Production code changes, CI, APK signing and deployment are NOT complete. Next: inspect current main StoreBillingSync/StoreBillingStore/Worker routes and active PRs, implement phased code changes and tests, then update shared handoff without overwriting other agents.
