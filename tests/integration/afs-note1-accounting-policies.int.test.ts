/**
 * AFS note 1 (accounting policies) on real PostgreSQL.
 *
 * The note used to select companies.depreciation_method and
 * companies.inventory_valuation_method, columns the schema has never had, so it
 * failed for every company; the mocked unit test fed it those columns and
 * passed. The policy text now comes from the company's own records:
 *   - the depreciation methods of the assets it held during the year
 *     (bought on or before the year end, not disposed of before it began);
 *   - the cost methods of its active inventory products;
 *   - an inventories policy only when it held inventory in the year: a balance
 *     at the prior year end, or a posted inventory movement in the year.
 * Three companies, FY2026 = 2025-03-01..2026-02-28. All data synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { generateNote1AccountingPolicies } from '@/modules/accounting/services/afs/noteGenerators/notes1to5';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { seedFiscalYears } from './helpers/fiscalYearSeed';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const STOCKED = randomUUID(), SOLDOUT = randomUUID(), BARE = randomUUID(), USER = randomUUID();
const ALL = [STOCKED, SOLDOUT, BARE];
const TAG = STOCKED.slice(0, 8);
const inventory = randomUUID(), bank = randomUUID(), soldInventory = randomUUID(), soldBank = randomUUID();

async function inTx<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const out = await als.run({ client, companyId, userId: USER, claims: {} } as never, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function asset(companyId: string, n: number, method: string, bought: string, disposed: string | null) {
  await sql`
    INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years,
      depreciation_method, disposal_date, status)
    VALUES (${companyId}::UUID, ${`${TAG}-A${n}`}, ${`Asset ${n}`}, ${bought}::DATE, 1000, 5,
      ${method}, ${disposed}::DATE, ${disposed ? 'disposed' : 'available'})`;
}

/** Positive amount: stock bought for cash; negative: stock sold out of the account. */
async function stockJournal(companyId: string, stock: string, cash: string, entryDate: string, amount: number) {
  const a = Math.abs(amount);
  const je = await createJournalEntry(companyId, {
    entryDate, description: amount > 0 ? 'stock purchase' : 'stock sold', source: 'manual',
    lines: amount > 0
      ? [{ glAccountId: stock, debit: a, credit: 0 }, { glAccountId: cash, debit: 0, credit: a }]
      : [{ glAccountId: cash, debit: a, credit: 0 }, { glAccountId: stock, debit: 0, credit: a }],
  }, USER);
  await inTx(companyId, () => postJournalEntry(companyId, je.id, USER));
}

async function product(companyId: string, n: number, costMethod: string, type: string, active: boolean) {
  await sql`INSERT INTO products (company_id, code, name, product_type, cost_method, is_active)
            VALUES (${companyId}::UUID, ${`${TAG}-P${n}`}, ${`Product ${n}`}, ${type}, ${costMethod}, ${active})`;
}

type Para = { type: 'paragraph'; text: string };
type Head = { type: 'heading'; text: string };

async function note1(companyId: string, fiscalYear = 2026) {
  const r = await inTx(companyId, () => generateNote1AccountingPolicies(companyId, fiscalYear));
  const blocks = r.content.blocks as Array<Para | Head>;
  const headings = blocks.filter((b): b is Head => b.type === 'heading').map((b) => b.text);
  const policy = (heading: string) => {
    const i = blocks.findIndex((b) => b.type === 'heading' && b.text === heading);
    return i >= 0 ? (blocks[i + 1] as Para).text : null;
  };
  return { snapshot: r.dataSnapshot, headings, policy };
}

describeIfDb('AFS note 1 accounting policies from the company records', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    await sql`INSERT INTO companies (id, name, financial_year_start, default_currency)
              VALUES (${STOCKED}::UUID, ${'N1 stocked ' + TAG}, 3, 'ZAR'), (${SOLDOUT}::UUID, ${'N1 soldout ' + TAG}, 3, 'ZAR'),
                     (${BARE}::UUID, ${'N1 bare ' + TAG}, 3, 'ZAR')`;
    for (const c of ALL) {
      await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c}::UUID, ${USER}, 'admin')`;
      await seedFiscalYears(c, '2024-03-01', '2027-02-28');
    }
    await sql`
      INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active, account_subtype)
      VALUES (${inventory}::UUID, ${STOCKED}::UUID, '1400', 'Inventory', 'asset', 'debit', 3, true, 'inventory'),
             (${bank}::UUID, ${STOCKED}::UUID, '1000', 'Bank', 'asset', 'debit', 3, true, 'bank'),
             (${soldInventory}::UUID, ${SOLDOUT}::UUID, '1400', 'Inventory', 'asset', 'debit', 3, true, 'inventory'),
             (${soldBank}::UUID, ${SOLDOUT}::UUID, '1000', 'Bank', 'asset', 'debit', 3, true, 'bank')`;
    await asset(STOCKED, 1, 'straight_line', '2024-06-01', null); // held all year
    await asset(STOCKED, 2, 'reducing_balance', '2025-09-01', null); // bought in the year
    await asset(STOCKED, 3, 'sum_of_years', '2023-01-01', '2025-01-31'); // gone before the year began
    await asset(STOCKED, 4, 'sum_of_years', '2026-04-01', null); // bought after the year end
    await stockJournal(STOCKED, inventory, bank, '2025-10-15', 500); // still held at 2026-02-28 and after
    await stockJournal(SOLDOUT, soldInventory, soldBank, '2025-05-10', 100);
    await stockJournal(SOLDOUT, soldInventory, soldBank, '2025-08-20', -100); // nil at the FY2026 year end
    await product(STOCKED, 1, 'weighted_average', 'inventory', true);
    await product(STOCKED, 2, 'fifo', 'inventory', true);
    await product(SOLDOUT, 3, 'fifo', 'inventory', true);
    await product(SOLDOUT, 4, 'weighted_average', 'inventory', false); // inactive: not a method in use
    await product(BARE, 5, 'fifo', 'service', true); // a service is not inventory
  }, 120000);

  afterAll(async () => {
    try {
      await sql`DELETE FROM gl_journal_lines WHERE company_id = ANY(${ALL}::UUID[])`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ANY(${ALL}::UUID[])`;
      await sql`DELETE FROM gl_account_balances WHERE gl_account_id = ANY(${[inventory, bank, soldInventory, soldBank]}::UUID[])`;
      await sql`DELETE FROM gl_accounts WHERE company_id = ANY(${ALL}::UUID[])`;
      await sql`DELETE FROM assets WHERE company_id = ANY(${ALL}::UUID[])`;
      await sql`DELETE FROM products WHERE company_id = ANY(${ALL}::UUID[])`;
      await sql`DELETE FROM fiscal_periods WHERE company_id = ANY(${ALL}::UUID[])`;
      await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
      await sql`DELETE FROM companies WHERE id = ANY(${ALL}::UUID[])`;
      await sql`DELETE FROM users WHERE id = ${USER}`;
    } finally { await getPoolForTests().end(); }
  });

  it('names the methods of the assets held during the year, and only those', async () => {
    const { policy, snapshot } = await note1(STOCKED);
    const ppe = policy('Property, Plant and Equipment')!;
    expect(ppe).toContain('the straight-line or reducing-balance method, as set for each asset,');
    expect(ppe).not.toMatch(/sum-of-the-years/i);
    expect(snapshot.depreciation_methods).toEqual(['straight_line', 'reducing_balance']);
  });

  it('states the inventories policy, naming the cost methods of the active inventory products', async () => {
    const { headings, policy, snapshot } = await note1(STOCKED);
    expect(headings).toContain('Inventories');
    expect(policy('Inventories')).toContain('the weighted average cost or first-in, first-out (FIFO) method, as set for each item.');
    expect(snapshot).toMatchObject({ holds_inventory: true, inventory_cost_methods: ['weighted_average', 'fifo'] });
  });

  it('a year that opens with stock keeps the policy (the comparative still shows it)', async () => {
    const { headings } = await note1(STOCKED, 2027); // no movement in FY2027; 500 held at 2026-02-28
    expect(headings).toContain('Inventories');
  });

  it('leaves the inventories policy out when the stock was bought after the year end', async () => {
    const { headings, snapshot } = await note1(STOCKED, 2025); // FY2025 ends 2025-02-28, before the purchase
    expect(headings).not.toContain('Inventories');
    expect(snapshot.holds_inventory).toBe(false);
  });

  it('stock bought and sold out within the year: the policy stays that year, the next year drops it', async () => {
    const sold = await note1(SOLDOUT);
    expect(sold.headings).toContain('Inventories');
    expect(sold.policy('Inventories')).toContain('Cost is determined using the first-in, first-out (FIFO) method.');
    expect(sold.policy('Inventories')).not.toMatch(/weighted average/);
    expect((await note1(SOLDOUT, 2027)).headings).not.toContain('Inventories');
  });

  it('a company with no assets and no stock: default depreciation text, no inventories policy, no other company\'s methods', async () => {
    const { headings, policy, snapshot } = await note1(BARE);
    expect(policy('Property, Plant and Equipment')).toContain('the straight-line method');
    expect(policy('Property, Plant and Equipment')).not.toMatch(/reducing-balance/);
    expect(headings).not.toContain('Inventories');
    expect(snapshot).toMatchObject({ depreciation_methods: [], inventory_cost_methods: [], holds_inventory: false, default_currency: 'ZAR' });
  });
});
