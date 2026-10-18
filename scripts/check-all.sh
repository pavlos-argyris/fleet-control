#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 scripts/prepare-pdf-viewer.py
python3 scripts/check-source-safety.py
python3 scripts/prepare-static-assets.py --check
node scripts/check-release-capacity.mjs
node scripts/check-web-assets.mjs cloudflare-worker/public client-android/assets/www
node --check server-android/assets/www/app.js
node scripts/test-server-update-ui.mjs
node scripts/test-client-ota-ui.mjs
node scripts/test-ota-setup.mjs
node --test scripts/test-publish-request.mjs
node scripts/test-ota-releases.mjs
node scripts/test-api-recovery.mjs
node scripts/test-worker-snapshot-load.mjs
node scripts/test-worker-model.mjs
node scripts/test-service-workflow.mjs
node scripts/test-invoice-imports.mjs
node scripts/test-service-model.mjs
node scripts/test-fleet-operations-model.mjs
node scripts/test-fleet-operations-ui.mjs
node scripts/test-service-followup.mjs
node scripts/test-sequential-review.mjs
node scripts/test-pdf-evidence.mjs
node scripts/test-dialog-navigation.mjs
node scripts/test-new-service-ui.mjs
node scripts/test-view-cache.mjs
node scripts/test-invoice-import-ui.mjs
node scripts/test-invoice-improvements.mjs
node scripts/test-invoice-library.mjs
node scripts/test-service-order.mjs
node scripts/test-scroll-stability.mjs
node scripts/test-progress-ring.mjs
node scripts/test-payroll-regressions.mjs
node scripts/test-schedule-regressions.mjs
node scripts/test-admin-simulations.mjs
node scripts/test-backup-restore-local.mjs
node scripts/test-offload-d1.mjs
node scripts/test-offload-polling.mjs
node scripts/test-shared-requests.mjs
node scripts/test-live-changes.mjs
node scripts/test-change-events.mjs
