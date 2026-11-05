// A deterministic sweep: random journals over a fixed chart (loans, cards, VAT, payroll, disposals, equity, two banks, legs
// running both ways), each on its own day. For EVERY day and for the month, the indirect and direct methods must give the same
// operating / investing / financing totals and both must close on the ledger's cash.
import { describe, expect, it, vi } from 'vitest';
import { CO, describeIfDb, inTx, installCompanies, sec, tie } from './helpers/cashFlowAdversarialFixture';

vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));

installCompanies();

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const CHART: Array<[string, string, string | undefined]> = [
  ['asset', 'fixed_asset', undefined], ['asset', 'accumulated_depreciation', 'credit'], ['revenue', 'disposal_profit_loss', undefined],
  ['asset', 'receivable', undefined], ['liability', 'payable', undefined], ['asset', 'vat_input', undefined], ['liability', 'vat_output', undefined],
  ['revenue', 'revenue', undefined], ['expense', 'operating_expense', undefined], ['liability', 'long_term_liability', undefined],
  ['liability', 'bank_account', undefined], ['equity', 'equity', undefined], ['liability', 'payroll_liability', undefined],
  ['asset', 'inventory', undefined], ['asset', 'non_current_asset', undefined], ['asset', 'prepaid_expense', undefined],
];

describeIfDb('cash flow: indirect and direct agree on random journals', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 28 journals, one a day, every day and the month agree`, async () => {
      await inTx(async (x) => {
        const banks = [await x.acct('asset', 'bank'), await x.acct('asset', 'bank')];
        const ids: string[] = [];
        for (const [t, s, nb] of CHART) ids.push(await x.acct(t, s, nb));
        const sys = (await x.c.query(
          `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_system_account)
           VALUES ($1,'2215','Current portion','liability','current_liability','credit',true) RETURNING id`, [CO])).rows[0].id as string;
        ids.push(sys);
        const r = rng(seed * 7919);
        const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)]!;
        for (let day = 1; day <= 28; day++) {
          const legs: Array<[string, number, number]> = [];
          let net = 0; // debit less credit of the non-cash legs
          for (let n = 2 + Math.floor(r() * 3); n > 0; n--) {
            const amount = 100 * (1 + Math.floor(r() * 90)), debit = r() < 0.5;
            legs.push([pick(ids), debit ? amount : 0, debit ? 0 : amount]);
            net += debit ? amount : -amount;
          }
          if (net !== 0) {
            const two = r() < 0.3 && Math.abs(net) >= 200, first = two ? Math.floor(Math.abs(net) / 200) * 100 : Math.abs(net);
            const side = (a: number): [number, number] => (net > 0 ? [0, a] : [a, 0]); // the cash legs balance the journal
            legs.push([banks[0]!, ...side(first)]);
            if (two) legs.push([banks[1]!, ...side(Math.abs(net) - first)]);
          }
          await x.j(`2026-11-${String(day).padStart(2, '0')}`, legs, r() < 0.15 ? { source: 'auto_asset_disposal' } : {});
        }
        for (let day = 1; day <= 28; day++) {
          const d = `2026-11-${String(day).padStart(2, '0')}`;
          const t = await tie(d, d);
          expect({ d, op: sec(t.ind, 'Operating'), inv: sec(t.ind, 'Investing'), fin: sec(t.ind, 'Financing') })
            .toEqual({ d, op: expect.closeTo(t.dir.operatingTotal, 2), inv: expect.closeTo(t.dir.investingTotal, 2), fin: expect.closeTo(t.dir.financingTotal, 2) });
        }
        const month = await tie('2026-11-01', '2026-11-30');
        expect({ op: sec(month.ind, 'Operating'), inv: sec(month.ind, 'Investing'), fin: sec(month.ind, 'Financing') })
          .toEqual({ op: month.dir.operatingTotal, inv: month.dir.investingTotal, fin: month.dir.financingTotal });
        expect(month.dir.closingCash).toBe(month.gl);
      });
    }, 120_000);
  }
});
