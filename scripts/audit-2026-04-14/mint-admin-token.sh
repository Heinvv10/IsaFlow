#!/usr/bin/env bash
# Mints a fresh 2-hour JWT for admin@isaflow.co.za against dev DB.
set -euo pipefail
cd "$(dirname "$0")/../.."
export $(grep -E '^(DATABASE_URL|JWT_SECRET)=' .env.local | xargs)
bun run scripts/mint-for-admin-qa.ts
