/**
 * The SQL half of the subtype-coverage check, asserted against a real ledger.
 *
 * WHY THIS FILE EXISTS. The mocked suite exercises
 * `buildSubtypeCoverageResult` and cannot see `fetchAccountMovement` at all —
 * so the one-token edit that turns the whole check OFF (`je.status = 'posted'`
 * → any other literal, which returns zero rows and therefore an unconditional
 * `pass`) left every test green. A check that can be silenced by an untested
 * token is the defect class this repo keeps finding; these assertions are
 * properties of whatever the ledger holds rather than fixed amounts, so
 * concurrent sessions changing dev data cannot make them flake.
 *
 * IT REPORTS SKIPPED, NOT PASSED. `vitest.config.ts` substitutes
 * `postgresql://dummy:dummy@dummy/test` when DATABASE_URL is absent and
 * `isDbReachable` returns false for it, so the usual `if (!dbUp) return;`
 * prologue scores every test PASSED with no database — a suite written to close
 * a "green while silenced" hole, recreating it one layer up. These use
 * `it.skipIf`, so an unreachable database shows as `↓ skipped` in the run
 * summary and nobody can read this file's green as evidence.
 *
 * Read-only. Writes nothing.
 */

import { describe, it, expect } from 'vitest';
import { sql } from '@/lib/neon';
import { fetchAccountMovement } from '@/modules/accounting/services/core/migrationSubtypeCheck';
import { isDbReachable } from '../helpers/dbReachable';

/**
 * Probed at MODULE LOAD, not in `beforeAll`. `it.skipIf` is evaluated during
 * collection, which happens before any hook runs — a `beforeAll` here left
 * every test skipped even against a live database, which is the same "green
 * proves nothing" failure in a different costume.
 */
const dbUp = await isDbReachable();

/** DATABASE_URL was set to something real, so "unreachable" is a failure. */
const expectsDb = Boolean(process.env['DATABASE_URL'])
  && !(process.env['DATABASE_URL'] ?? '').includes('dummy');

describe('the database gate itself', () => {
  it('is reachable whenever a real DATABASE_URL is configured', () => {
    if (!expectsDb) return; // no DB configured: the suite below reports skipped
    expect(dbUp).toBe(true);
  });
});

/** A company with posted GL movement, and one with drafts, if either exists. */
async function companyWithPostedLines(): Promise<string | null> {
  const rows = (await sql`
    SELECT je.company_id, COUNT(*) AS n
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
    WHERE je.status = 'posted'
    GROUP BY je.company_id
    ORDER BY n DESC
    LIMIT 1
  `) as { company_id: string }[];
  return rows[0]?.company_id ?? null;
}

describe('fetchAccountMovement — against a real ledger', () => {
  it.skipIf(!dbUp)('returns rows for a company that has posted journal lines', async () => {
    const companyId = await companyWithPostedLines();
    expect(companyId, 'no company in this database has posted GL lines').not.toBeNull();

    const rows = await fetchAccountMovement(companyId);
    expect(rows.length).toBeGreaterThan(0);
    // Mutating `je.status = 'posted'` to any other literal empties this.
  });

  it.skipIf(!dbUp)('reads ONLY posted lines — a draft-only account never appears', async () => {
    const companyId = await companyWithPostedLines();
    if (!companyId) return;

    const draftOnly = (await sql`
      SELECT ga.account_code
      FROM gl_accounts ga
      WHERE ga.company_id = ${companyId}::UUID
        AND EXISTS (
          SELECT 1 FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
          WHERE jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
            AND je.status <> 'posted'
        )
        AND NOT EXISTS (
          SELECT 1 FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
          WHERE jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
            AND je.status = 'posted'
        )
    `) as { account_code: string }[];
    if (draftOnly.length === 0) return;

    const codes = new Set((await fetchAccountMovement(companyId)).map(r => r.account_code));
    for (const d of draftOnly) expect(codes.has(d.account_code)).toBe(false);
    // Dropping `AND je.status = 'posted'` turns this red.
  });

  it.skipIf(!dbUp)('returns only accounts belonging to the company asked for', async () => {
    const companyId = await companyWithPostedLines();
    if (!companyId) return;

    const rows = await fetchAccountMovement(companyId);
    const owned = (await sql`
      SELECT account_code FROM gl_accounts WHERE company_id = ${companyId}::UUID
    `) as { account_code: string }[];
    const ownedCodes = new Set(owned.map(o => o.account_code));
    for (const r of rows) expect(ownedCodes.has(r.account_code)).toBe(true);
    // HONEST LIMIT, measured: dropping `ga.company_id` does NOT turn this red.
    // `jl.company_id` already scopes the join and gl_journal_lines only ever
    // reference their own tenant's accounts, so the ga predicate is defence in
    // depth and no behavioural test can distinguish it. Dropping `jl.company_id`
    // is the one that leaks, and that is what this assertion actually guards.
  });

  it.skipIf(!dbUp)('agrees with the ledger on net and gross, per account', async () => {
    const companyId = await companyWithPostedLines();
    if (!companyId) return;

    const rows = await fetchAccountMovement(companyId);
    const biggest = [...rows].sort(
      (a, b) => Math.abs(Number(b.net)) - Math.abs(Number(a.net)),
    )[0];
    if (!biggest) return;

    const truth = (await sql`
      SELECT
        SUM(COALESCE(jl.debit, 0) - COALESCE(jl.credit, 0)) AS net,
        SUM(COALESCE(jl.debit, 0) + COALESCE(jl.credit, 0)) AS gross
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      WHERE jl.company_id = ${companyId}::UUID
        AND ga.account_code = ${biggest.account_code}
        AND je.status = 'posted'
    `) as { net: string; gross: string }[];

    expect(Number(biggest.net)).toBeCloseTo(Number(truth[0]?.net ?? 0), 2);
    expect(Number(biggest.gross)).toBeCloseTo(Number(truth[0]?.gross ?? 0), 2);
    // Swapping to SUM(credit - debit) inverts net and turns this red.
    // Note gross >= |net| always: it is what the nil-balance disclosure reads.
  });

  it.skipIf(!dbUp)('never returns gross movement smaller than the absolute net balance', async () => {
    const companyId = await companyWithPostedLines();
    if (!companyId) return;

    for (const r of await fetchAccountMovement(companyId)) {
      expect(Math.abs(Number(r.gross))).toBeGreaterThanOrEqual(Math.abs(Number(r.net)) - 0.005);
    }
    // Swapping the two SELECT expressions turns this red.
  });
});
