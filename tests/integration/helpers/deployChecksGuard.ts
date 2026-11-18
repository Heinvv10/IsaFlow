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
 *
 * Blind spots. A write the suite makes at module level runs at collection, before the first check, so it is never
 * seen. Writes to any database but DATABASE_URL are not checked. "JE balance (per entry)" and "Overall TB balance"
 * carry no offending count, so once one leak fails them they stay failed and no later file in the shard is caught on
 * them. A check that throws (a timeout, say) fails the next file's beforeAll, not the file that caused it. Writes that
 * land late, from background work a suite left running, are blamed on whichever file runs next.
 */
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { coreChecks } from '../../../scripts/lib/integrityChecks';
import { tenantChecks } from '../../../scripts/lib/integrityChecksTenant';
import type { CheckResult } from '../../../scripts/lib/integrityTypes';
import { regressions } from '../../../scripts/lib/demoReseed/postCheck';
import { txOver } from '../../../scripts/lib/demoReseed/db';
import { IN_INTEGRATION_GATE } from '../../helpers/integrationGate';

/** The hooks' own limit; the checks give up (and end their connection) well inside it. */
const HOOK_MS = 120_000;
const DEADLINE_MS = 100_000;

/**
 * The deploy checks, as demo-reseed and verify-deploy run them (postCheck.deployChecks), on their own connection.
 * The connection always ends before the hook times out: each statement is bounded by the server (statement_timeout),
 * the client stops waiting a little later in case the server never answers (query_timeout, which must exceed it), and
 * the whole run is cut at DEADLINE_MS by ending the client, which fails the pending query.
 */
async function deployCheckResults(url: string): Promise<CheckResult[]> {
  const client = new pg.Client({ connectionString: url, statement_timeout: 30_000, query_timeout: 35_000 });
  let ending: Promise<void> | undefined;
  const end = (): Promise<void> => (ending ??= client.end());
  // The timer only starts the end; `finally` awaits the same promise, so an error ending the client is raised there.
  const deadline = setTimeout(() => { end().catch((err: unknown) => err); }, DEADLINE_MS);
  try {
    await client.connect();
    const tx = txOver(client);
    const out: CheckResult[] = [];
    for (const check of [...coreChecks, ...tenantChecks]) out.push(await check(tx.sql));
    return out;
  } finally {
    clearTimeout(deadline);
    await end();
  }
}

if (IN_INTEGRATION_GATE) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('deployChecksGuard: the integration gate runs every suite with DATABASE_URL set');
  let before: CheckResult[] | undefined;

  beforeAll(async () => {
    before = await deployCheckResults(url);
  }, HOOK_MS);

  // Vitest requires the hook's first argument to be a destructuring pattern; the second is the file.
  afterAll(async ({}, suite) => {
    if (!before) return;
    const worse = regressions(before, await deployCheckResults(url));
    if (worse.length === 0) return;
    const what = worse.map((c) => `  ${c.label}: ${c.detail ?? ''}${(c.lines ?? []).slice(0, 5).map((l) => `\n    ${l}`).join('')}`);
    throw new Error(`${suite.file.name} left the shared fixture failing deploy integrity checks that passed before it `
      + `(demo-reseed fails on them for every suite after it in the shard). Clean up what the suite made:\n${what.join('\n')}`);
  }, HOOK_MS);
}
