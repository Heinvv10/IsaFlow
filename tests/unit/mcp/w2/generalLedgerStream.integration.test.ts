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
 *
 * R-165: every read below shares ONE transaction via `withBusiestCompany`
 * (generalLedgerStream.helpers.ts), pinned to REPEATABLE READ so a peer's
 * concurrent commit can never make two of our reads disagree — see that
 * file's doc comment for the mechanism, and the regression test below.
 */
import { describe, it, expect, vi } from 'vitest';
import { isDbReachable } from '../../helpers/dbReachable';
import {
  PERIOD_START,
  PERIOD_END,
  withBusiestCompany,
  drain,
  isDisposableFixtureTarget,
  commitConcurrentPostedLine,
  deleteConcurrentPostedLine,
} from './generalLedgerStream.helpers';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import {
  getGeneralLedgerLines,
  type GeneralLedgerLine,
} from '@/modules/accounting/services/gl/generalLedgerStreamService';

const isNulledByFyStart = (l: GeneralLedgerLine, from: string | null) =>
  from !== null && l.date >= from && (l.accountType === 'revenue' || l.accountType === 'expense');

describe('general-ledger line stream — real database', async () => {
  const reachable = await isDbReachable();

  // Every OTHER test in this file only reads, so it is safe against
  // isaflow_dev. The R-165 regression test below WRITES a posted journal
  // entry (see generalLedgerStream.helpers.ts) — `bun run ci` runs this
  // suite through `env -u DATABASE_URL`, which does NOT actually unset it
  // (vite's loadEnv re-reads .env.local → isaflow_dev regardless). Refuse to
  // write there, at prod, or at isaflow_staging (a full prod copy on the
  // same cluster) — `isDisposableFixtureTarget` is an ALLOWLIST, not a
  // denylist of the names known so far, so an unnamed shared database also
  // fails closed. The test simply skips when it doesn't hold; its mechanism
  // is already captured in docs/audits/remediation/R-165/{red,mutations}.log.
  const canWriteHere = reachable && isDisposableFixtureTarget();

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
        // Null only for an income-statement line on or after the first FY start in range.
        const nulled = isNulledByFyStart(line, whole.incomeStatementBalanceNullFrom);
        expect(line.runningBalance === null).toBe(nulled);
        if (!nulled) expect(line.runningBalance).toBeCloseTo(byId.get(line.lineId) as number, 2);
        else expect(byId.get(line.lineId)).toBeNull();
      }
    });
  }, 60000);

  it.skipIf(!canWriteHere)(
    'is not disturbed by a peer session committing a posted line mid-read (R-165 regression)',
    async () => {
      try {
        await withBusiestCompany(async (companyId) => {
          const base = { companyId, periodStart: PERIOD_START, periodEnd: PERIOD_END, limit: 500 };
          const before = await getGeneralLedgerLines({ ...base, after: null });

          // A peer posts a new BALANCED entry (2 lines) for the SAME company
          // on its OWN connection — the exact shape of the flake.
          const committedCount = await commitConcurrentPostedLine(companyId, 115, PERIOD_START);

          // Non-vacuity, checked on the WRITER's own connection: the write
          // really landed, or a mis-scoped fix could pass below vacuously.
          expect(committedCount).toBe(before.lineCount + 2);

          const whole = await getGeneralLedgerLines({ ...base, limit: 100000, after: null });

          // The transaction under test must be BLIND to the peer's commit: same
          // line count, same runningBalance on every line it already read.
          expect(whole.lineCount).toBe(before.lineCount);
          const byId = new Map(whole.lines.map((l) => [l.lineId, l.runningBalance]));
          for (const line of before.lines) {
            if (line.runningBalance === null) expect(byId.get(line.lineId)).toBeNull();
            else expect(line.runningBalance).toBeCloseTo(byId.get(line.lineId) as number, 2);
          }
        });
      } finally {
        await deleteConcurrentPostedLine();
      }
    },
    60000,
  );

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
        // An income-statement account whose range crosses a FY start has no balance from that
        // start (the stream inserts no close line); every other account closes exactly.
        if (isNulledByFyStart(last, page.incomeStatementBalanceNullFrom)) {
          expect(last.runningBalance).toBeNull();
          continue;
        }
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
