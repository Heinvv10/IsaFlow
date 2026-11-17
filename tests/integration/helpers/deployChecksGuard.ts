/**
 * THE SUITE THAT BREAKS A DEPLOY INTEGRITY CHECK FAILS ITSELF, BY NAME (a `setupFiles` entry of
 * vitest.integration.config.ts). The deploy's 16 integrity checks (scripts/lib/integrityChecks*.ts) scan every
 * company, and demo-reseed asserts none of them fails. A suite that leaves, say, a posted journal with no fiscal
 * period in the shared fixture (budgetsRouteFixture, #1551) used to fail only demo-reseed, and only when the shard
 * deal put demo-reseed after it. This runs the checks before and after each file and fails that file when one got
 * worse (postCheck.regressions: a new fail, or more offending rows), so an earlier suite's leak is never blamed on it.
 *
 * Gate only (CI_INTEGRATION_GATE=1, run.sh): there each shard runs one file at a time on its own throwaway database,
 * so the difference is that file's. Run by hand, against a database other suites or sessions share, it does nothing.
 */
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { coreChecks } from '../../../scripts/lib/integrityChecks';
import { tenantChecks } from '../../../scripts/lib/integrityChecksTenant';
import type { CheckResult } from '../../../scripts/lib/integrityTypes';
import { regressions } from '../../../scripts/lib/demoReseed/postCheck';
import { txOver } from '../../../scripts/lib/demoReseed/db';
import { IN_INTEGRATION_GATE } from '../../helpers/integrationGate';

/** The deploy checks, as demo-reseed and verify-deploy run them (postCheck.deployChecks), on their own connection. */
async function deployCheckResults(url: string): Promise<CheckResult[]> {
  const client = new pg.Client({ connectionString: url, statement_timeout: 60_000 });
  await client.connect();
  try {
    const tx = txOver(client);
    const out: CheckResult[] = [];
    for (const check of [...coreChecks, ...tenantChecks]) out.push(await check(tx.sql));
    return out;
  } finally {
    await client.end();
  }
}

if (IN_INTEGRATION_GATE) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('deployChecksGuard: the integration gate runs every suite with DATABASE_URL set');
  let before: CheckResult[] | undefined;

  beforeAll(async () => {
    before = await deployCheckResults(url);
  }, 120_000);

  // Vitest requires the hook's first argument to be a destructuring pattern; the second is the file.
  afterAll(async ({}, suite) => {
    if (!before) return;
    const worse = regressions(before, await deployCheckResults(url));
    if (worse.length === 0) return;
    const what = worse.map((c) => `  ${c.label}: ${c.detail ?? ''}${(c.lines ?? []).slice(0, 5).map((l) => `\n    ${l}`).join('')}`);
    throw new Error(`${suite.file.name} left the shared fixture failing deploy integrity checks that passed before it `
      + `(demo-reseed fails on them for every suite after it in the shard). Clean up what the suite made:\n${what.join('\n')}`);
  }, 120_000);
}
