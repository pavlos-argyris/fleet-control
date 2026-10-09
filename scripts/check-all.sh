#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 scripts/check-source-safety.py
node scripts/check-web-assets.mjs cloudflare-worker/public client-android/assets/www
node --check server-android/assets/www/app.js
node scripts/test-ota-setup.mjs
node --test scripts/test-publish-request.mjs
node scripts/test-ota-releases.mjs
node scripts/test-worker-model.mjs
node scripts/test-service-workflow.mjs
node scripts/test-invoice-improvements.mjs
node scripts/test-payroll-regressions.mjs
node scripts/test-schedule-regressions.mjs
node scripts/test-admin-simulations.mjs
node scripts/test-backup-restore-local.mjs
