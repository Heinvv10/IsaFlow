/**
 * The two equity bases, against isaflow_dev. Read-only; DB-gated.
 *
 * WHY THIS EXISTS. `getBalanceSheet` reports `totalEquity`, and that figure is
 * NOT independent of the residual: `fetchBalanceSheetData` computes retained
 * earnings as revenue less expenses to the date and injects it into the equity
 * section. By double entry, assets − liabilities − posted equity IS revenue
 * less expenses, so `totalEquity` equals assets − liabilities by construction.
 *
 * Reporting it beside `equityResidual` therefore proves nothing, and it looked
 * like it proved something: on all three production companies the two figures
 * agreed to the cent, which reads as a clean set of books. Querying the equity
 * accounts directly says otherwise — **Brightsphere and Velocity Fibre both
 * carry R0.00 of POSTED equity.** Every cent of Brightsphere's R8,394,848.60
 * and of Velocity's −R34,816,224.89 is a derived plug.
 *
 * So `getEquityBases` returns what the equity ACCOUNTS hold, separately from
 * what the balance sheet injects. The identity below is what makes the two
 * figures checkable rather than merely printed:
 *
 *     assets − liabilities = postedEquity + derivedRetainedEarnings
 *
 * KNOWN DEV-DATA DEFECT (2026-09-06). In the isaflow_dev copy, Brightsphere's
 * JE-2026-00002 posts a R450.00 debit to account 1140, an asset owned by ANOTHER
 * company. Since every gl_accounts join is scoped to the company (WS3, PR #332),
 * the balance sheet no longer reads across that tenant boundary, so this identity
 * fails there by exactly R450.00: the entry genuinely does not balance within
 * Brightsphere's own accounts. On master it only held because the unscoped join
 * picked up the foreign leg. Production carries no such line (read-only check).
 * The cure is a ledger correction in the dev copy, not a change to this test.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getPoolForTests, sql } from '@/lib/neon';
import { getBalanceSheet, getEquityBases } from '@/modules/accounting/services/reports/balanceSheetService';

type AlsCtx = Parameters<typeof als.run>[0];
const AS_AT = '2026-12-31';

async function withLedgerCompanies(run: (ids: string[]) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    await als.run(
      { client, userId: 'test', companyId: 'bootstrap', claims: {} } as unknown as AlsCtx,
      async () => {
        const rows = (await sql`
          SELECT jl.company_id AS id, COUNT(*) AS n
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
          GROUP BY jl.company_id
          ORDER BY COUNT(*) DESC
          LIMIT 3
        `) as Array<{ id: string }>;
        if (rows.length === 0) throw new Error('no company with posted journal lines in isaflow_dev');
        await run(rows.map((r) => r.id));
      },
    );
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

describe('equity bases — real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('closes the identity: A − L = postedEquity + derivedRetainedEarnings', async () => {
    await withLedgerCompanies(async (companyIds) => {
      for (const companyId of companyIds) {
        const sheet = await getBalanceSheet(companyId, AS_AT);
        const bases = await getEquityBases(companyId, AS_AT);
        const residual = sheet.totalAssets - sheet.totalLiabilities;
        expect(bases.posted + bases.derivedRetainedEarnings).toBeCloseTo(residual, 2);
      }
    });
  }, 60000);

  it.skipIf(!reachable)('reports a POSTED figure that is not simply the residual', async () => {
    await withLedgerCompanies(async (companyIds) => {
      let sawPlug = false;
      for (const companyId of companyIds) {
        const sheet = await getBalanceSheet(companyId, AS_AT);
        const bases = await getEquityBases(companyId, AS_AT);
        const residual = sheet.totalAssets - sheet.totalLiabilities;
        // `totalEquity` is the plug-inclusive figure and equals the residual by
        // construction. That is the whole reason it cannot be the second
        // opinion — this asserts the property rather than trusting the comment.
        expect(sheet.totalEquity).toBeCloseTo(residual, 2);
        if (Math.abs(bases.derivedRetainedEarnings) > 0.01) sawPlug = true;
      }
      // On these books at least one company's equity is substantially derived.
      // Without this the case passes on a set of books where the distinction
      // does not arise, which says nothing about whether it was drawn.
      expect(sawPlug).toBe(true);
    });
  }, 60000);

  it.skipIf(!reachable)('scopes both figures to the company it was given', async () => {
    await withLedgerCompanies(async (companyIds) => {
      const results = await Promise.all(
        companyIds.map(async (id) => JSON.stringify(await getEquityBases(id, AS_AT))),
      );
      // Different companies must not produce one shared answer — the shape a
      // missing company_id filter takes.
      expect(new Set(results).size).toBeGreaterThan(1);
    });
  }, 60000);
});
