# Fleet Control — Integrating roadmap branches for a single future release

Started 2026-11-05, initial main source `4d52897b5c4c7feb3bc5cb21b367cf7337c1f6fd`, branch `codex/roadmap-integration-fleet-561`.

Sources: independently tested draft PRs #66 (#59 D1), #67 (#60 courier cash), #68 (#61 recovery evidence), #69 (#62 store reporting), #70 (#63 payroll warnings), #71 (#64 diagnostics), #72 (#8 Play Protect audit).

**This integration is NOT an approved release candidate yet.** It combines the pure/read-only cores and tests, but actual production Server/Client screens, databases, order-to-courier mapping, migration authorization, real backup/restore, device tests, PDF/XLSX exports and Play Protect resolution are still incomplete.

Only use reviewed source blobs, keep each original PR unchanged and isolated, merge shared `scripts/check-all.sh` and `docs/CODE_MAP.json` correctly, and verify exact-head CI. Do not merge to main or publish before a complete coordinated release (with new signed APK version, full source handoff, rollback and exact-main CI).

Actual production DB/Ordexa writes, restoring data and new secrets are NOT authorized by this integration branch. Documentation-only checkpoint; no deployment triggered.

Next: import each source/test/docs file as a source blob, combine code map and full tests, open draft integration PR, run CI, then implement missing real functional integration in isolated iterations.
