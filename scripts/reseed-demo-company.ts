/**
 * Reseed the IsaFlow Demo company with fictional, date-safe data.
 *
 *   DEMO_RESEED_DATABASE_URL=postgresql://... bun scripts/reseed-demo-company.ts \
 *     --company 00000000-0000-0000-0000-000000000001 [--dry-run | --check-only] [--today YYYY-MM-DD] [--seed N]
 *
 * One transaction: wipe every Demo transaction table, seed 24 months ending
 * today, run the post-checks, COMMIT only if all pass. `--dry-run` prints what
 * would be deleted, inserted and kept; `--check-only` runs the read-only
 * post-checks. Both write nothing. Refuses any company but the Demo company.
 * Exit codes: 0 done or clean, 1 a post-check failed (rolled back), 2 refused.
 * Contract and rules: scripts/lib/demoReseed/.claude.md.
 */

import { runAsProcess } from './lib/demoReseed/main';

runAsProcess();
