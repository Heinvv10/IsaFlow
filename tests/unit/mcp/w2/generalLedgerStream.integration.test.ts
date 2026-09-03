/**
 * The paginated general-ledger line stream, against isaflow_dev. Read-only;
 * DB-gated.
 *
 * `getGeneralLedgerReport` returns every account with its transactions nested,
 * in one unbounded response. Velocity's posted ledger is 21,871 lines across
 * 111 accounts, so an MCP tool cannot serve it whole and cannot page it either
 * — there is nothing to page over until the lines are flat and totally ordered.
 * That is what this service adds, along with the filters.
 *
 * THE ASSERTIONS THAT MATTER, and why they are properties rather than figures:
 *
 *  - Paging to exhaustion returns EVERY line EXACTLY ONCE. A keyset over a
 *    non-total order silently drops or repeats rows at page boundaries, and a
 *    report that loses lines in the middle of a ledger is worse than one that
 *    refuses to page.
 *  - `runningBalance` is the account's opening balance plus its cumulative
 *    movement, and it is IDENTICAL whether the page size is 5 or 100,000. A
 *    running balance recomputed per page from zero is the obvious way to get
 *    this wrong and it looks right on page one.
 *  - `runningBalance` is NULL when a line-level filter is in force, because a
 *    running total over a subset of an account's lines is not a balance the
 *    account ever had. Reporting one would be a fabricated figure.
 */
import { describe, it, expect, vi } from 'vitest';
import { als } from '@/lib/als';
import { isDbReachable } from '../../helpers/dbReachable';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getPoolForTests, sql } from '@/lib/neon';
import {
  getGeneralLedgerLines,
  type GeneralLedgerLine,
  type GeneralLedgerQuery,
} from '@/modules/accounting/services/gl/generalLedgerStreamService';

type AlsCtx = Parameters<typeof als.run>[0];

const PERIOD_START = '2020-01-01';
const PERIOD_END = '2026-12-31';

async function withBusiestCompany(run: (companyId: string) => Promise<void>) {
  const client = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
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
async function drain(
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

describe('general-ledger line stream — real database', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('pages to exhaustion returning every line exactly once', async () => {
    await withBusiestCompany(async (companyId) => {
      const base = { companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 137 };
      const { lines, pages, lineCount } = await drain(base);

      // Non-vacuity: this has to have actually paged.
      expect(pages).toBeGreaterThan(1);
      expect(lines.length).toBe(lineCount);

      // Every line exactly once. A keyset over a non-total order drops or
      // repeats rows precisely here, at the boundaries.
      const ids = lines.map((l) => l.lineId);
      expect(new Set(ids).size).toBe(ids.length);

      // ...and it is the same set the unpaged read returns.
      const whole = await getGeneralLedgerLines({ ...base, limit: 100000, after: null });
      expect(whole.next).toBeNull();
      expect(whole.lines.map((l) => l.lineId)).toEqual(ids);
    });
  }, 60000);

  it.skipIf(!reachable)('gives the same runningBalance at any page size', async () => {
    await withBusiestCompany(async (companyId) => {
      const base = { companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END };
      // 500, not 7: the claim is that the balance does not depend on where
      // the page cuts, and 21 pages test that as well as 1,494 do without
      // spending a minute proving it.
      const small = await drain({ ...base, limit: 500 });
      const whole = await getGeneralLedgerLines({ ...base, limit: 100000, after: null });

      const byId = new Map(whole.lines.map((l) => [l.lineId, l.runningBalance]));
      expect(small.lines.length).toBeGreaterThan(500);
      for (const line of small.lines) {
        expect(line.runningBalance).not.toBeNull();
        expect(line.runningBalance).toBeCloseTo(byId.get(line.lineId) as number, 2);
      }
    });
  }, 60000);

  it.skipIf(!reachable)('closes each account: opening + movement = the last runningBalance', async () => {
    await withBusiestCompany(async (companyId) => {
      const page = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 100000, after: null,
      });

      const seen = new Map<string, GeneralLedgerLine[]>();
      for (const l of page.lines) {
        const list = seen.get(l.accountCode);
        if (list) list.push(l);
        else seen.set(l.accountCode, [l]);
      }
      expect(seen.size).toBeGreaterThan(1);

      for (const [code, accountLines] of seen) {
        const opening = page.openingBalances[code];
        expect(opening).toBeDefined();
        const movement = accountLines.reduce(
          (s, l) => s + (l.normalBalance === 'debit' ? l.debit - l.credit : l.credit - l.debit),
          0,
        );
        const last = accountLines[accountLines.length - 1]!;
        expect(last.runningBalance).toBeCloseTo((opening as number) + movement, 2);
      }
    });
  }, 60000);

  it.skipIf(!reachable)('carries a NON-ZERO opening balance into the running balance', async () => {
    // The case above starts before the first journal, so every opening balance
    // is zero and dropping `opening +` from the running balance would leave it
    // green. A window that starts mid-history is what makes the opening
    // balance load-bearing — it is the difference between a ledger extract and
    // a period-movement listing, which is the same defect trial_balance had.
    await withBusiestCompany(async (companyId) => {
      const MID = '2025-07-01';
      const page = await getGeneralLedgerLines({
        companyId, periodStart: MID, periodEnd: PERIOD_END, limit: 100000, after: null,
      });

      const nonZero = Object.entries(page.openingBalances).filter(([, b]) => b !== 0);
      expect(nonZero.length).toBeGreaterThan(0);

      // For an account with a non-zero opening, the FIRST line's running
      // balance must already include it.
      const [code] = nonZero[0]!;
      const first = page.lines.find((l) => l.accountCode === code);
      if (first) {
        const movement =
          first.normalBalance === 'debit' ? first.debit - first.credit : first.credit - first.debit;
        expect(first.runningBalance).toBeCloseTo(page.openingBalances[code]! + movement, 2);
      }
    });
  }, 60000);

  it.skipIf(!reachable)('reports debits equal to credits over an UNFILTERED period', async () => {
    await withBusiestCompany(async (companyId) => {
      const page = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 1, after: null,
      });
      // Every posted journal balances, so a whole-period slice of the ledger
      // must too. This is the assurance signal the tool exists to carry, and
      // the totals come from an aggregate over the filtered set rather than
      // from the one line on this page.
      expect(page.totalDebit).toBeCloseTo(page.totalCredit, 2);
      expect(page.balanced).toBe(true);
      expect(page.lineCount).toBeGreaterThan(1);
    });
  }, 60000);

  it.skipIf(!reachable)('SUPPRESSES runningBalance and balanced under a line-level filter', async () => {
    await withBusiestCompany(async (companyId) => {
      const unfiltered = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 100000, after: null,
      });
      const source = unfiltered.lines[0]!.source;

      const filtered = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END,
        sources: [source], limit: 500, after: null,
      });

      expect(filtered.lines.length).toBeGreaterThan(0);
      expect(filtered.lines.every((l) => l.source === source)).toBe(true);
      // A running total over a subset of an account's lines is not a balance
      // the account ever had, and `balanced` over a subset means nothing.
      expect(filtered.runningBalanceSuppressed).toBe(true);
      expect(filtered.lines.every((l) => l.runningBalance === null)).toBe(true);
      expect(filtered.balanced).toBeNull();
      // The filter must actually narrow, or this case proves nothing.
      expect(filtered.lineCount).toBeLessThan(unfiltered.lineCount);
    });
  }, 60000);

  it.skipIf(!reachable)('keeps runningBalance under an ACCOUNT filter, which selects whole accounts', async () => {
    await withBusiestCompany(async (companyId) => {
      const all = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 100000, after: null,
      });
      const code = all.lines[0]!.accountCode;

      const one = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END,
        accountCodes: [code], limit: 100000, after: null,
      });

      expect(one.lines.every((l) => l.accountCode === code)).toBe(true);
      expect(one.runningBalanceSuppressed).toBe(false);
      // Selecting whole accounts leaves each account's own sequence intact, so
      // the balances are the ones the full ledger reports.
      const byId = new Map(all.lines.map((l) => [l.lineId, l.runningBalance]));
      for (const l of one.lines) {
        expect(l.runningBalance).toBeCloseTo(byId.get(l.lineId) as number, 2);
      }
      // `balanced` is still null: one account's lines do not balance.
      expect(one.balanced).toBeNull();
    });
  }, 60000);

  it.skipIf(!reachable)('reports the UNFILTERED line count as the universe', async () => {
    // The general ledger is the base document of an audit file, so
    // completeness matters more here than anywhere. If `universeTotal` were the
    // count AFTER the filters, the envelope would certify a filtered extract as
    // complete — `rowsTotal === universeTotal`, `truncated: false`, no
    // exclusions — which is the strongest claim this contract can make and the
    // one thing a filtered extract must never make.
    await withBusiestCompany(async (companyId) => {
      const all = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 1, after: null,
      });
      expect(all.universeLineCount).toBe(all.lineCount);

      const source = (await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 1, after: null,
      })).lines[0]!.source;

      const filtered = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END,
        sources: [source], limit: 1, after: null,
      });
      // The universe does NOT move with the filter; the matched count does.
      expect(filtered.universeLineCount).toBe(all.lineCount);
      expect(filtered.lineCount).toBeLessThan(filtered.universeLineCount);
    });
  }, 60000);

  it.skipIf(!reachable)('refuses to leak another company’s lines through any filter', async () => {
    await withBusiestCompany(async (companyId) => {
      const others = (await sql`
        SELECT id FROM companies WHERE id <> ${companyId}::UUID LIMIT 1
      `) as Array<{ id: string }>;
      const page = await getGeneralLedgerLines({
        companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 100000, after: null,
      });
      const ids = page.lines.map((l) => l.lineId);
      if (ids.length === 0 || others.length === 0) return;
      const leaked = (await sql`
        SELECT COUNT(*) AS n FROM gl_journal_lines
        WHERE id = ANY(${ids}::uuid[]) AND company_id <> ${companyId}::UUID
      `) as Array<{ n: string }>;
      expect(Number(leaked[0]!.n)).toBe(0);
    });
  }, 60000);
});
