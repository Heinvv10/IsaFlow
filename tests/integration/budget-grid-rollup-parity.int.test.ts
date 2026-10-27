/**
 * R5 parity (Budgets P2 PR-C): the client grid store's header roll-up and band totals equal the
 * SERVER's for the same cells. The server's `GridAccount.rollup` is built in loadGridAccounts
 * after a database read (not a pure export), so the check runs here: the real read model from a
 * seeded company, fed to the real `GridStore`, compared header by header and metric by metric.
 * The header's sub-accounts differ per month, one sits at CC1 grain (the company roll-up of two
 * members), and the header holds a legacy own budget (counted in the band totals once, never in
 * its roll-up).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { loadGridReadModel, type GridReadModel } from '@/modules/accounting/services/budgets/gridReadModel';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import type { Metric } from '@/modules/accounting/services/budgets/grid/subtotals';
import { GridStore, rollupRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { budgetGridFixture, monthsFrom, type GridCo } from './helpers/budgetGridFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = budgetGridFixture(pool);
const FY27 = monthsFrom('2026-03');
const METRICS: Metric[] = ['turnover', 'costOfSales', 'grossProfit', 'otherIncome', 'operatingExpenses', 'operatingProfit', 'otherExpenses', 'netProfit'];

let A: GridCo;
let model: GridReadModel;

beforeAll(async () => {
  A = await fx.company();
  const a = A.acct;
  const v = await fx.version(A, { fy: 2027, name: 'Original', kind: 'original', status: 'approved', primary: true });
  await fx.amounts(A, v, a.sales, FY27, 1000);
  await fx.amounts(A, v, a.cos, FY27, 400.25);
  for (const [i, m] of FY27.entries()) await fx.amount(A, v, a.childA, m, 30 + i * 1.5);
  await fx.amounts(A, v, a.childB, FY27.slice(0, 6), 20, { cc1: A.cc1 });
  await fx.amounts(A, v, a.childB, FY27.slice(3), 12.34, { cc1: A.cc1b });
  await fx.amount(A, v, a.header, '2026-03', 7); // legacy own budget on the header
  await fx.amount(A, v, a.otherIncome, '2026-05', 40);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    model = await als.run({ client, companyId: A.id, userId: A.user, claims: {} } as never, () => loadGridReadModel(A.id, { versionId: v }));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}, 120000);

afterAll(async () => {
  try {
    await fx.cleanup();
  } finally {
    await pool.end();
  }
}, 60000);

describe('client store vs server read model', () => {
  it('every header roll-up row equals GridAccount.rollup, month by month (cents; a month with nothing is 0)', () => {
    const store = new GridStore();
    store.reset(model, { view: { kind: 'company' }, canWrite: true });
    const headers = model.accounts.filter((x) => x.isHeader && x.rollup !== null);
    expect(headers.map((h) => h.id)).toContain(A.acct.header);
    for (const h of headers) {
      const server = h.rollup!.map(toCents);
      const client = store.getRow(rollupRowKey(h.id)).values.map((x) => x ?? 0);
      expect(client, h.code).toEqual(server);
    }
    // Not a vacuous match: the header's roll-up moves month to month and includes the CC1 members.
    const h = model.accounts.find((x) => x.id === A.acct.header)!;
    expect(toCents(h.rollup![0]!)).toBe(3000 + 2000);
    expect(toCents(h.rollup![4]!)).toBe(3600 + 2000 + 1234);
  });

  it('the live band totals and GP / OP / NP equal the read model\'s totals (the header\'s own R7 once)', () => {
    const store = new GridStore();
    store.reset(model, { view: { kind: 'company' }, canWrite: true });
    for (const m of METRICS) {
      expect(store.getTotal(m).months, m).toEqual(model.totals.months[m].map(toCents));
      expect(store.getTotal(m).fy, m).toBe(toCents(model.totals.fy[m]));
    }
    expect(store.fyTotals().operatingExpenses).toBe(model.totals.fy.operatingExpenses);
  });
});
