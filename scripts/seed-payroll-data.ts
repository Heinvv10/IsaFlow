/**
 * Retired: the Demo company's employees, pay runs and payroll journals now come from the whole-company reseed,
 * scripts/reseed-demo-company.ts (fictional names, nothing dated after today,
 * DEMO_MONTHS_FORWARD = 0: a rolling 24-month window ending on the run date).
 * The old body seeded real company names, realistic identity and tax numbers,
 * future-dated rows and documents that never reached the ledger.
 *
 * This file keeps its name so old runbooks fail safe: it runs the same reseed,
 * with the same contract, and refuses without it.
 *
 *   DEMO_RESEED_DATABASE_URL=postgresql://... bun scripts/seed-payroll-data.ts \
 *     --company 00000000-0000-0000-0000-000000000001 [--dry-run | --check-only]
 *
 * See scripts/lib/demoReseed/.claude.md.
 */

import { runAsProcess } from './lib/demoReseed/main';

runAsProcess('scripts/seed-payroll-data.ts is retired: running the whole IsaFlow Demo reseed (scripts/reseed-demo-company.ts) instead.');
