/**
 * The disclosure must agree with the banding it describes, against a real
 * ledger. The pure suite proves the arithmetic; only a database proves that
 * `getIncomeStatement` actually populates it and that the amount it names is
 * genuinely sitting in `operatingExpenses` on the same report object.
 *
 * Probed at MODULE LOAD, not in `beforeAll`: `it.skipIf` is evaluated during
 * collection, so a hook-based probe leaves every test skipped even against a
 * live database. An absent database shows as `↓ skipped`, never as passed.
 *
 * Writes inside a transaction that is always rolled back.
 */

import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { getIncomeStatement } from '@/modules/accounting/services/reports/incomeStatementService';
import { isDbReachable } from '../../helpers/dbReachable';
import { assertNotProductionDb } from '../../../helpers/assertNotProductionDb';
import { ctxFor, inRolledBackTx, postEntry } from '../../helpers/vatControlFixture';

const dbUp = await isDbReachable();
const expectsDb = Boolean(process.env['DATABASE_URL'])
  && !(process.env['DATABASE_URL'] ?? '').includes('dummy');

describe('the database gate itself', () => {
  it('is reachable whenever a real DATABASE_URL is configured', () => {
    if (!expectsDb) return;
    expect(dbUp).toBe(true);
  });
});

/**
 * A ledger that PROVABLY has unclassified expense accounts with movement.
 *
 * Seeded, not found: migration 608 backfilled every NULL-subtype
 * revenue/expense account on the live tenants and `createAccount` now refuses
 * to make another, so a query for "some company with the defect" comes back
 * empty on a healthy database. The rows are written by raw INSERT (the only
 * way to produce the state any more) inside a transaction that is always
 * rolled back. Two unclassified expenses and one classified one, so the
 * disclosure has something to name AND something it must leave out.
 */
interface Seeded { id: string; from: string; to: string; expenseAccounts: number }

async function seedUnclassifiedLedger(client: PoolClient, opts: { classified?: boolean } = {}): Promise<Seeded> {
  const { rows: co } = await client.query<{ id: string }>(
    `INSERT INTO companies (name) VALUES ('IS disclosure fixture') RETURNING id`,
  );
  const companyId = co[0]!.id;
  const account = async (code: string, type: string, subtype: string | null, normal: string) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1,$2,$2,$3,$4,$5,true) RETURNING id`,
      [companyId, code, type, subtype, normal],
    );
    return rows[0]!.id;
  };
  const sales = await account('4000', 'revenue', 'revenue', 'credit');
  const bank = await account('1110', 'asset', 'bank', 'debit');
  const cos = await account('5100', 'expense', 'cost_of_sales', 'debit');
  const bareSubtype = opts.classified ? 'operating_expense' : null;
  const bare1 = await account('5200', 'expense', bareSubtype, 'debit');
  const bare2 = await account('5300', 'expense', bareSubtype, 'debit');

  await postEntry(client, companyId, null, '2026-03-01', [
    { accountId: bank, debit: 10000, credit: 0 }, { accountId: sales, debit: 0, credit: 10000 },
  ]);
  await postEntry(client, companyId, null, '2026-03-10', [
    { accountId: cos, debit: 4000, credit: 0 }, { accountId: bare1, debit: 2500, credit: 0 },
    { accountId: bare2, debit: 500, credit: 0 }, { accountId: bank, debit: 0, credit: 7000 },
  ]);
  return { id: companyId, from: '2026-03-01', to: '2026-03-31', expenseAccounts: opts.classified ? 0 : 2 };
}

/** Seed, run `fn` under the same connection, always roll back. */
async function withSeededLedger(fn: (c: Seeded) => Promise<void>, opts: { classified?: boolean } = {}): Promise<void> {
  assertNotProductionDb('This test inserts a company, GL accounts and journals.');
  await inRolledBackTx(async (client) => {
    const c = await seedUnclassifiedLedger(client, opts);
    await als.run(ctxFor(client, c.id), () => fn(c));
  });
}

describe('getIncomeStatement — subtype disclosure against a real ledger', () => {
  it.skipIf(!dbUp)('is actually populated on the report for a chart that needs it', async () => {
    await withSeededLedger(async (c) => {
      const report = await getIncomeStatement(c.id, c.from, c.to);
      // NOT `if (!disclosure) return` — deleting the line in incomeStatementService
      // that puts this on the report must turn this red.
      expect(report.subtypeDisclosure).not.toBeNull();
      expect(report.subtypeDisclosure).toBeDefined();
      expect(report.subtypeDisclosure!.expenseAccounts).toBe(c.expenseAccounts);
      expect(report.subtypeDisclosure!.grossProfitOverstatedByAtMost).toBeCloseTo(3000, 2);
    });
  });

  it.skipIf(!dbUp)('names amounts that are genuinely inside operatingExpenses', async () => {
    await withSeededLedger(async (c) => {
      const report = await getIncomeStatement(c.id, c.from, c.to);
      const disclosure = report.subtypeDisclosure;
      expect(disclosure).toBeTruthy();

      const opex = new Map(report.operatingExpenses.map(i => [i.accountCode, i.amount]));
      const named = disclosure!.accounts.filter(a => a.accountType === 'expense');
      expect(named.length).toBeGreaterThan(0);
      for (const a of named) {
        // Every expense the disclosure names must actually be sitting in the
        // operating expenses section — that IS the claim it makes.
        expect(opex.has(a.accountCode)).toBe(true);
        expect(opex.get(a.accountCode)).toBeCloseTo(a.amount, 2);
      }
    });
  });

  it.skipIf(!dbUp)('counts every unclassified expense account the ledger has', async () => {
    await withSeededLedger(async (c) => {
      const report = await getIncomeStatement(c.id, c.from, c.to);
      expect(report.subtypeDisclosure).toBeTruthy();
      // >= not ==: the service drops accounts whose period amount rounds to nil,
      // and counts unrecognised spellings the NULL-only query above cannot see.
      // Dropping the disclosureRows.push for expenses takes this to 0.
      expect(report.subtypeDisclosure!.expenseAccounts).toBeGreaterThan(0);
      expect(report.subtypeDisclosure!.expenseAmount).toBeGreaterThan(0);
    });
  });

  it.skipIf(!dbUp)('bounds the COST OF SALES exposure by operating expenses', async () => {
    await withSeededLedger(async (c) => {
      const report = await getIncomeStatement(c.id, c.from, c.to);
      expect(report.subtypeDisclosure).toBeTruthy();
      const opexTotal = report.operatingExpenses.reduce((s, i) => s + Math.abs(i.amount), 0);
      // Only the cost-of-sales half is bounded by operating expenses. An earlier
      // version asserted this of `grossProfitOverstatedByAtMost`, which also
      // contains the REVENUE ceiling — it passed on the dev database (almost no
      // unclassified revenue) and failed against production on the very company
      // its own selector picked: "expected 200037895.31 to be <= 115984525.06".
      // Green on dev, red on prod, is not a test.
      expect(report.subtypeDisclosure!.costOfSalesExposureAtMost).toBeLessThanOrEqual(opexTotal + 0.01);
      expect(report.subtypeDisclosure!.costOfSalesExposureAtMost).toBeCloseTo(3000, 2);
    });
  });

  it.skipIf(!dbUp)('bounds the OTHER INCOME exposure by revenue', async () => {
    await withSeededLedger(async (c) => {
      const report = await getIncomeStatement(c.id, c.from, c.to);
      const d = report.subtypeDisclosure;
      expect(d).toBeTruthy();
      // Bounded by total income. Turnover alone would be the tighter claim, but
      // the disclosure's population is every revenue-typed account, so the honest
      // bound is turnover plus other income — matching what is asserted.
      expect(d!.otherIncomeExposureAtMost)
        .toBeLessThanOrEqual(Math.abs(report.totalRevenue) + Math.abs(report.totalOtherIncome) + 0.01);
    });
  });

  it.skipIf(!dbUp)('totals the two ceilings exactly', async () => {
    await withSeededLedger(async (c) => {
      const d = (await getIncomeStatement(c.id, c.from, c.to)).subtypeDisclosure;
      expect(d).toBeTruthy();
      expect(d!.grossProfitOverstatedByAtMost).toBeCloseTo(
        d!.costOfSalesExposureAtMost + d!.otherIncomeExposureAtMost, 2);
    });
  });

  it.skipIf(!dbUp)('is null when every account on the report has a recognised subtype', async () => {
    await withSeededLedger(async (c) => {
      const report = await getIncomeStatement(c.id, c.from, c.to);
      expect(report.subtypeDisclosure).toBeNull();
      // Same ledger, same totals: the banding is unchanged, only the disclosure goes.
      expect(report.operatingExpenses.reduce((s, i) => s + i.amount, 0)).toBeCloseTo(3000, 2);
    }, { classified: true });
  });
});
