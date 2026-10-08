/**
 * Shared machinery for generalLedgerStream.integration.test.ts: the
 * one-transaction/one-snapshot read helper (`withBusiestCompany`, `drain`)
 * and the R-165 regression test's concurrent write, which mimics a peer
 * session committing to isaflow_dev while ours is mid-flight — on its OWN
 * `pg.Pool` connection, autocommitting immediately, never on the ALS-bound
 * client the transaction under test uses.
 */
import { Pool } from 'pg';
import { fixtureDbUrlProblem } from '../../../integration/fixtureDbGuard';
import { randomUUID } from 'crypto';
import { als } from '@/lib/als';
import { getPoolForTests, sql } from '@/lib/neon';
import {
  getGeneralLedgerLines,
  type GeneralLedgerLine,
  type GeneralLedgerQuery,
} from '@/modules/accounting/services/gl/generalLedgerStreamService';

type AlsCtx = Parameters<typeof als.run>[0];

export const PERIOD_START = '2020-01-01';
export const PERIOD_END = '2026-12-31';

export async function withBusiestCompany(run: (companyId: string) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    // REPEATABLE READ, not the default READ COMMITTED: every statement below
    // must see the SAME snapshot, or a peer's concurrent commit between two
    // of our reads makes them disagree (R-165).
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await als.run(
      { client, userId: 'test', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        // The company with the most posted lines. Picking by uuid would sample
        // a company with an empty ledger and pass without paging anything.
        const rows = (await sql`
          SELECT jl.company_id AS id, COUNT(*) AS n
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
          GROUP BY jl.company_id
          ORDER BY COUNT(*) DESC
          LIMIT 1
        `) as Array<{ id: string }>;
        const companyId = rows[0]?.id;
        if (!companyId) throw new Error('no company with posted journal lines in isaflow_dev');
        await run(companyId);
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Pages to exhaustion, refusing to loop forever on a cursor that does not advance. */
export async function drain(
  base: Omit<GeneralLedgerQuery, 'after'>,
  maxPages = 400,
): Promise<{ lines: GeneralLedgerLine[]; pages: number; lineCount: number }> {
  const lines: GeneralLedgerLine[] = [];
  let after: GeneralLedgerQuery['after'] = null;
  let pages = 0;
  let lineCount = 0;
  for (;;) {
    const page = await getGeneralLedgerLines({ ...base, after });
    lines.push(...page.lines);
    lineCount = page.lineCount;
    pages += 1;
    if (page.next === null) break;
    if (pages >= maxPages) throw new Error(`cursor did not terminate after ${maxPages} pages`);
    after = page.next;
  }
  return { lines, pages, lineCount };
}

/**
 * A page size that drains the scope in about `pages` pages, never below
 * `floor`, and odd so the boundaries do not fall on round numbers. The Demo
 * company gains lines on every golden-paths run, so a fixed page size made the
 * drain's page count (and run time) grow without bound: 257 pages at ~150 ms
 * each for 35,073 lines, past the 60 s timeout under load (2026-10-08).
 */
export async function pageSizeFor(
  scope: Omit<GeneralLedgerQuery, 'after' | 'limit'>,
  pages: number,
  floor: number,
): Promise<number> {
  const { lineCount } = await getGeneralLedgerLines({ ...scope, limit: 1, after: null });
  return Math.max(floor, Math.ceil(lineCount / pages)) | 1;
}

/**
 * ALLOWLIST, not a denylist of known-unsafe names: `isaflow_staging` is a
 * full prod copy on the same cluster (see memory project_isaflow_staging_copy),
 * so refusing only "isaflow_dev"/"isaflow" would fail OPEN for it and any
 * other shared database nobody has named yet. This only ever returns true
 * for the exact disposable-fixture shape this repo's other DB-gated suites
 * already use (localhost/127.0.0.1 + database name isaflow_schema_fixture —
 * see tests/integration/mfa-impersonation-postgres.helpers.ts's own
 * assertDisposable, which enforces the same convention for a different
 * suite).
 */
export function isDisposableFixtureTarget(): boolean {
  // Read the way pg reads it (fixtureDbGuard): `?host=` would otherwise send a
  // "localhost" URL to another server (rev-d7-35ba3c9f2). Unparsable, or
  // anything but the local fixture, is not a disposable target — fail closed.
  return fixtureDbUrlProblem(process.env.DATABASE_URL, ['isaflow_schema_fixture']) === null;
}

/**
 * Refuses to touch anything but the disposable fixture, even if a caller
 * forgets the suite's own `canWriteHere` skip guard — `env -u DATABASE_URL`
 * does not actually unset it in this repo's vitest config (vite's loadEnv
 * re-reads .env.local), so a naive `DATABASE_URL` check is not enough on
 * its own. Both the write and its cleanup call this, so neither can ever
 * touch isaflow_dev, isaflow_staging (a full prod copy) or prod itself.
 */
function assertDisposableTarget(): void {
  if (!isDisposableFixtureTarget()) {
    throw new Error(
      `refusing to touch database "${process.env.DATABASE_URL ?? '(unset)'}" — ` +
        'this helper only ever writes to the disposable isaflow_schema_fixture, on localhost/127.0.0.1',
    );
  }
}

export const CONCURRENT_WRITE_MARKER = 'R-165 regression: concurrent write mid-read';

/**
 * Commits one balanced posted entry (a debit and its matching credit, 2
 * lines) onto the company's first two accounts, dated at `entryDate` so it
 * lands before every seeded line in the window — shifting every later
 * `runningBalance` on the debited/credited accounts. Returns the posted line
 * count read back on this SAME connection right after the commit, so a
 * caller can prove the write really landed without relying on the
 * transaction under test — which, once fixed, must NOT see it.
 */
export async function commitConcurrentPostedLine(
  companyId: string,
  amount: number,
  entryDate: string,
): Promise<number> {
  assertDisposableTarget();
  const writer = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const accounts = (await writer.query(
      'SELECT id FROM gl_accounts WHERE company_id = $1 ORDER BY account_code LIMIT 2',
      [companyId],
    )).rows as Array<{ id: string }>;
    if (accounts.length < 2) throw new Error('busiest company needs at least 2 accounts to balance a line');
    const je = (await writer.query(
      `INSERT INTO gl_journal_entries (entry_date, status, company_id, created_by, source, description)
       VALUES ($1, 'posted', $2, $3, 'manual', $4)
       RETURNING id`,
      [entryDate, companyId, randomUUID(), CONCURRENT_WRITE_MARKER],
    )).rows[0].id;
    await writer.query(
      `INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, company_id, debit, credit)
       VALUES ($1, $2, $4, $3, 0), ($1, $5, $4, 0, $3)`,
      [je, accounts[0]!.id, amount, companyId, accounts[1]!.id],
    );
    const after = await writer.query(
      `SELECT COUNT(*)::int AS n FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
       WHERE jl.company_id = $1`,
      [companyId],
    );
    return (after.rows[0] as { n: number }).n;
  } finally {
    await writer.end();
  }
}

/**
 * Undoes `commitConcurrentPostedLine`, so re-running the suite is idempotent.
 * Verifies the row is actually gone rather than trusting the DELETE's own
 * success: a WHERE clause that stops matching (a renamed column, a changed
 * marker) would otherwise leave the entry behind silently.
 */
export async function deleteConcurrentPostedLine(): Promise<void> {
  assertDisposableTarget();
  const writer = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await writer.query('DELETE FROM gl_journal_entries WHERE description = $1', [CONCURRENT_WRITE_MARKER]);
    const remaining = await writer.query(
      'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE description = $1',
      [CONCURRENT_WRITE_MARKER],
    );
    const n = (remaining.rows[0] as { n: number }).n;
    if (n !== 0) throw new Error(`cleanup left ${n} concurrent-write entr${n === 1 ? 'y' : 'ies'} behind`);
  } finally {
    await writer.end();
  }
}
