/**
 * D4 round 3: the consolidated trial balance against Postgres (temp tables,
 * rolled back). Members' income statements start at the fiscal year containing
 * the range END; eliminations must follow the same floor — P&L legs of
 * adjustments ending inside [floor, end] hit the P&L rows, earlier ones are
 * folded into Retained Earnings b/f, balance-sheet legs are cumulative — or the
 * group TB misstates revenue (C1) or stops footing (C3). Repros adopted from
 * agents/brk-d4/brkD4Consolidated.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { getConsolidatedTrialBalance } from '@/modules/accounting/services/reports/consolidatedTrialBalanceReport';
import { getTrialBalanceReport } from '@/modules/accounting/services/gl/trialBalanceService';
import { fiscalYearStart } from '@/modules/accounting/services/gl/fiscalYearBasis';
import { isDbReachable } from '../../helpers/dbReachable';
import { A, B, CODES, G, GROUP, net, withGroup, type Adj, type J } from './consolidatedGroupFixture';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

const IS_GROUP = new Set<keyof typeof G>(['rev', 'exp']);
const groupOf = (code: string) => CODES.find(c => c[0] === code)![3];

/** Intercompany sales and dividends over two and a half years, each eliminated by its own adjustment. */
const JOURNALS: J[] = [
  [A, '2024-12-01', [['1000', 1000, 0], ['3000', 0, 1000]]],
  [B, '2024-12-01', [['1000', 1000, 0], ['3000', 0, 1000]]],
];
const ADJUSTMENTS: Adj[] = [];
for (const [i, month] of ['2025-01', '2025-04', '2025-08', '2025-12', '2026-02', '2026-03', '2026-06', '2026-11'].entries()) {
  const day = `${month}-15`;
  const sale = 40 + i * 10;
  JOURNALS.push([A, day, [['1000', sale, 0], ['4000', 0, sale]]], [B, day, [['5000', sale, 0], ['1000', 0, sale]]]);
  ADJUSTMENTS.push([`${month}-01`, day, [['rev', sale, 0], ['exp', 0, sale]]]);
  if (i % 3 === 1) { // a dividend: P&L leg against an equity leg
    JOURNALS.push([A, day, [['1000', 25, 0], ['4000', 0, 25]]], [B, day, [['3000', 25, 0], ['1000', 0, 25]]]);
    ADJUSTMENTS.push([`${month}-01`, day, [['rev', 25, 0], ['cap', 0, 25]]]);
  }
  JOURNALS.push([A, `${month}-20`, [['1000', 7 + i, 0], ['4000', 0, 7 + i]]]); // third-party sale
}

/** Credit-positive, straight from the fixture: members' lines plus eliminations, on the members' floor. */
function expected(g: keyof typeof G | 'RE-BF', end: string, floor: string): number {
  let total = 0;
  for (const [, date, lines] of JOURNALS) {
    if (date > end) continue;
    for (const [code, dr, cr] of lines) {
      const k = groupOf(code);
      const isPl = IS_GROUP.has(k);
      if (g === 'RE-BF' ? isPl && date < floor : k === g && (!isPl || date >= floor)) total += cr - dr;
    }
  }
  for (const [, adjEnd, lines] of ADJUSTMENTS) {
    if (adjEnd > end) continue;
    for (const [k, dr, cr] of lines) {
      const isPl = IS_GROUP.has(k);
      if (g === 'RE-BF' ? isPl && adjEnd < floor : k === g && (!isPl || adjEnd >= floor)) total += cr - dr;
    }
  }
  return Math.round(total * 100) / 100;
}

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function ranges(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const months of [1, 3, 12, 24]) {
    for (let i = 2025 * 12; i + months - 1 <= 2026 * 12 + 11; i += months === 1 ? 1 : 2) {
      const e = i + months - 1;
      const [sy, sm, ey, em] = [Math.floor(i / 12), (i % 12) + 1, Math.floor(e / 12), (e % 12) + 1];
      out.push([`${sy}-${String(sm).padStart(2, '0')}-01`, `${ey}-${String(em).padStart(2, '0')}-${lastDay(ey, em)}`]);
    }
  }
  return out;
}

describe('consolidated trial balance — eliminations on the members\' fiscal-year floor (Postgres)', async () => {
  const reachable = await isDbReachable();

  it.skipIf(!reachable)('C1: a prior-FY P&L elimination in a range crossing the FY start goes to RE-BF, not current revenue', async () => {
    await withGroup(3, 3, [
      [A, '2025-06-01', [['1000', 1000, 0], ['3000', 0, 1000]]],
      [B, '2025-06-01', [['1000', 1000, 0], ['3000', 0, 1000]]],
      [A, '2026-01-15', [['1000', 100, 0], ['4000', 0, 100]]],
      [B, '2026-01-15', [['5000', 100, 0], ['1000', 0, 100]]],
      [A, '2026-01-20', [['1000', 30, 0], ['4000', 0, 30]]], // third-party, prior FY
      [A, '2026-06-01', [['1000', 500, 0], ['4000', 0, 500]]],
    ], [['2026-01-01', '2026-01-31', [['rev', 100, 0], ['exp', 0, 100]]]], [], async () => {
      const tb = await getConsolidatedTrialBalance(GROUP, '2026-01-01', '2026-12-31');
      const row = (code: string) => tb.groupAccounts.find(r => r.accountCode === code);
      expect([net(row('G4000')), net(row('G5000'))]).toEqual([500, 0]);
      // The note says FY ending 2026-02-28 went to RE-BF: 130 − 100 member profit, eliminations net 0.
      expect(tb.fiscalYearEndsClosed[A]).toEqual(['2026-02-28']);
      expect(net(row('RE-BF'))).toBe(30);
      expect(tb.balanced).toBe(true);
    });
  });

  it.skipIf(!reachable)('C3: a dividend eliminated earlier in the fiscal year leaves a later month balanced', async () => {
    await withGroup(3, 3, [
      [A, '2025-06-01', [['1000', 1000, 0], ['3000', 0, 1000]]],
      [B, '2025-06-01', [['1000', 1000, 0], ['3000', 0, 1000]]],
      [A, '2026-06-15', [['1000', 50, 0], ['4000', 0, 50]]],
      [B, '2026-06-15', [['3000', 50, 0], ['1000', 0, 50]]],
    ], [['2026-06-01', '2026-06-30', [['rev', 50, 0], ['cap', 0, 50]]]], [], async () => {
      const tb = await getConsolidatedTrialBalance(GROUP, '2026-09-01', '2026-09-30');
      expect([tb.totalDebit, tb.totalCredit, tb.balanced]).toEqual([2000, 2000, true]);
      expect(net(tb.groupAccounts.find(r => r.accountCode === 'G4000'))).toBe(0);
    });
  });

  it.skipIf(!reachable)('foots and equals an independent sum for every range and FY start month', async () => {
    for (let fy = 1; fy <= 12; fy++) {
      await withGroup(fy, fy, JOURNALS, ADJUSTMENTS, [], async () => {
        let crossing = 0;
        for (const [start, end] of ranges()) {
          const at = `fy ${fy} ${start}..${end}`;
          const floor = fiscalYearStart(end, fy);
          const tb = await getConsolidatedTrialBalance(GROUP, start, end);
          expect([tb.balanced, tb.difference], at).toEqual([true, 0]);
          for (const g of Object.keys(G) as Array<keyof typeof G>) {
            const code = 'G' + CODES.find(c => c[3] === g)![0];
            expect(net(tb.groupAccounts.find(r => r.accountCode === code)), `${at} ${code}`).toBe(expected(g, end, floor));
          }
          expect(net(tb.groupAccounts.find(r => r.accountCode === 'RE-BF')), `${at} RE-BF`).toBe(expected('RE-BF', end, floor));
          const closed = tb.fiscalYearEndsClosed[A]!.length > 0;
          expect(closed, `${at} note`).toBe(floor > start);
          if (closed) crossing += 1;
        }
        expect(crossing).toBeGreaterThan(5);
      });
    }
  }, 180000);

  // 5c, held: members with different FY starts. Each member column equals its own TB and the group foots.
  it.skipIf(!reachable)('C2: March and July members — member columns equal each own TB, and the group foots', async () => {
    const PA = '90000000-0000-4000-8000-000000000001'; const PB = '90000000-0000-4000-8000-000000000002';
    await withGroup(3, 7, JOURNALS, ADJUSTMENTS, [[PA, A, '2026-01-01', '2026-12-31'], [PB, B, '2026-01-01', '2026-12-31']], async () => {
      const tb = await getConsolidatedTrialBalance(GROUP, '2026-01-01', '2026-12-31');
      expect(tb.balanced).toBe(true);
      for (const [co, pid] of [[A, PA], [B, PB]] as const) {
        for (const r of (await getTrialBalanceReport(co, pid)).rows) {
          const g = tb.groupAccounts.find(x => x.accountCode === (r.accountCode === 'RE-BF' ? 'RE-BF' : 'G' + r.accountCode));
          const e = g?.entities[co] ?? { debit: 0, credit: 0 };
          expect(e.debit - e.credit, `${co} ${r.accountCode}`).toBeCloseTo(r.debitBalance - r.creditBalance, 2);
        }
      }
      for (const [start, end] of ranges()) {
        expect((await getConsolidatedTrialBalance(GROUP, start, end)).balanced, `${start}..${end}`).toBe(true);
      }
    });
  }, 60000);
});
