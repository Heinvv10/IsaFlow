/**
 * Re-records tests/unit/ci/fixtures/verifyCompanyRoutes.json: the real `data` of every app route the verify provisioner's seeding and
 * readiness code consumes, which tests/unit/ci/verifyCompanyContract.test.ts checks those consumers against. Run it after a change
 * to any of those routes, or when the contract test and a real run disagree. It runs the REAL provisioner (realDeps) on a throwaway
 * hosted golden stack, so the stack must be FRESH (no verify company yet): a re-run skips the blocks and records only GETs.
 *
 *   RUNNER_TEMP=<dir> bash scripts/ci/golden-hosted/up.sh                      # a throwaway PG + GoTrue, writes .env.local
 *   bunx next dev -p <port>                                                    # the app on it (NEXT_PUBLIC_APP_URL=http://localhost:<port>)
 *   VERIFY_COMPANY_DATABASE_URL=$DATABASE_URL GOTRUE_URL=$GOTRUE_URL SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY \   # from .env.local
 *     bun scripts/deploy/verifyCompany/recordRoutes.ts --expect-database isaflow_golden --base-url http://localhost:<port> \
 *       --env-file <a new temp file> --out tests/unit/ci/fixtures/verifyCompanyRoutes.json
 *
 * Refuses the production database name. The deploy locks are replaced by temp files (it is a drill). The file gets a `_recorded`
 * header (when, by what, how to redo it) that the contract test requires.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { assertConnectedToDatabase } from '../../ci/golden/slotConfig';
import { Client } from '../../ci/golden-hosted/seed-demo-app';
import { parseOptions } from './config';
import { PRODUCTION_DATABASE } from './identity';
import { realDeps } from './realDeps';
import { runProvisioning } from './run';

/** Every route the consumers call; a recording that lacks one came from a stack that was not fresh. */
export const EXPECTED_ROUTES = [
  'GET /api/accounting/companies?action=user-companies', 'POST /api/accounting/customers', 'POST /api/payroll/components', 'POST /api/payroll/employees',
  'POST /api/payroll/employees/:id/components', 'POST /api/accounting/customer-invoices-create', 'POST /api/accounting/customer-invoices-detail',
  'POST /api/accounting/suppliers-list', 'POST /api/accounting/supplier-invoices', 'POST /api/accounting/supplier-invoices-action',
  'GET /api/accounting/chart-of-accounts?subtype=default_revenue', 'GET /api/accounting/bank-accounts', 'POST /api/accounting/journal-entries',
  'POST /api/accounting/journal-entries-action', 'POST /api/accounting/bank-transactions-bulk-commit', 'POST /api/accounting/chart-of-accounts',
  'GET /api/accounting/budgets?years_only=1', 'POST /api/accounting/budget-versions', 'POST /api/onboarding/complete-setup',
  'GET /api/accounting/budget-grid?fiscal_year=2027', 'GET /api/accounting/budget-grid/prior-actuals?fiscal_year=2027&grain=company',
] as const;

/** The fixture's key for a call: the method and the path, with every uuid as `:id`. */
export const recordKey = (method: string, path: string): string => `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id')}`;

/** Arrays cut to `max` items (the grid has 15 accounts: the cut is generous), everything else as it came. */
export function trimBody(v: unknown, max = 40): unknown {
  if (Array.isArray(v)) return v.slice(0, max).map((x) => trimBody(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, trimBody(x, max)]));
  return v;
}

/** The recorded routes missing from `recorded` (budget years are matched by any year). */
export function missingRoutes(recorded: Record<string, unknown>): string[] {
  const have = Object.keys(recorded).map((k) => k.replace(/fiscal_year=\d+/, 'fiscal_year=2027'));
  return EXPECTED_ROUTES.filter((r) => !have.includes(r));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const out = argv[argv.indexOf('--out') + 1];
  if (argv.indexOf('--out') < 0 || !out) throw new Error('--out <fixture file> is required');
  const opts = parseOptions(argv, process.env);
  if (opts.expectDatabase === PRODUCTION_DATABASE) throw new Error('recordRoutes is a drill: it refuses the production database');
  process.env.GOTRUE_URL = opts.goTrueUrl;

  const recorded: Record<string, unknown> = {};
  const call = (Client.prototype as unknown as { call: (...a: unknown[]) => Promise<unknown> }).call;
  (Client.prototype as unknown as { call: unknown }).call = async function (this: Client, method: string, path: string, body?: unknown) {
    const data = await call.call(this, method, path, body);
    const key = recordKey(method, path);
    if (!(key in recorded)) recorded[key] = trimBody(data);
    return data;
  };

  const db = new pg.Client({ connectionString: opts.databaseUrl });
  await db.connect();
  try {
    await assertConnectedToDatabase(db, opts.expectDatabase);
    const locks = ['a', 'b'].map((n) => join(mkdtempSync(join(tmpdir(), 'record-routes-')), `${n}.lock`));
    await runProvisioning({ ...opts, dryRun: false }, realDeps(db, opts.envFile, opts.baseUrl, (l) => process.stdout.write(`${l}\n`), locks));
  } finally {
    await db.end();
  }
  const lacking = missingRoutes(recorded);
  if (lacking.length) throw new Error(`the recording lacks ${lacking.join(', ')}: the stack was not fresh (a re-run skips the blocks that make them)`);
  const file = {
    _recorded: {
      at: new Date().toISOString(),
      by: 'scripts/deploy/verifyCompany/recordRoutes.ts',
      from: 'the hosted golden stack (scripts/ci/golden-hosted/up.sh) with next dev, through the real provisioner (realDeps)',
      redo: 'see the header of scripts/deploy/verifyCompany/recordRoutes.ts',
    },
    ...recorded,
  };
  writeFileSync(out, `${JSON.stringify(file, null, 1)}\n`);
  process.stdout.write(`recorded ${Object.keys(recorded).length} routes to ${out}\n`);
}

if ((import.meta as { main?: boolean }).main) {
  main().then(() => process.exit(0), (err: unknown) => {
    process.stderr.write(`recordRoutes failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
