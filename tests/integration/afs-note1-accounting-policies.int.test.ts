/**
 * AFS note 1 (accounting policies) on real PostgreSQL.
 *
 * The note used to select companies.depreciation_method and
 * companies.inventory_valuation_method, columns the schema has never had, so it
 * failed for every company; the mocked unit test fed it those columns and
 * passed. The policy text now comes from the company's own records:
 *   - the depreciation methods of the assets it held during the year
 *     (bought on or before the year end, not disposed of before it began);
 *   - an inventories policy only when inventory accounts carry a balance at the
 *     year end (the same test note 9 uses).
 * Two companies, FY2026 = 2025-03-01..2026-02-28. All data synthetic.
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

const STOCKED = randomUUID(), BARE = randomUUID(), USER = randomUUID();
const TAG = STOCKED.slice(0, 8);
const inventory = randomUUID(), bank = randomUUID();

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

async function stockJournal(entryDate: string, amount: number) {
  const je = await createJournalEntry(STOCKED, {
    entryDate, description: 'stock purchase', source: 'manual',
    lines: [{ glAccountId: inventory, debit: amount, credit: 0 }, { glAccountId: bank, debit: 0, credit: amount }],
  }, USER);
  await inTx(STOCKED, () => postJournalEntry(STOCKED, je.id, USER));
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
              VALUES (${STOCKED}::UUID, ${'N1 stocked ' + TAG}, 3, 'ZAR'), (${BARE}::UUID, ${'N1 bare ' + TAG}, 3, 'ZAR')`;
    await sql`INSERT INTO company_users (company_id, user_id, role)
              VALUES (${STOCKED}::UUID, ${USER}, 'admin'), (${BARE}::UUID, ${USER}, 'admin')`;
    await seedFiscalYears(STOCKED, '2024-03-01', '2026-12-31');
    await seedFiscalYears(BARE, '2024-03-01', '2026-12-31');
    await sql`
      INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, normal_balance, level, is_active, account_subtype)
      VALUES (${inventory}::UUID, ${STOCKED}::UUID, '1400', 'Inventory', 'asset', 'debit', 3, true, 'inventory'),
             (${bank}::UUID, ${STOCKED}::UUID, '1000', 'Bank', 'asset', 'debit', 3, true, 'bank')`;
    await asset(STOCKED, 1, 'straight_line', '2024-06-01', null); // held all year
    await asset(STOCKED, 2, 'reducing_balance', '2025-09-01', null); // bought in the year
    await asset(STOCKED, 3, 'sum_of_years', '2023-01-01', '2025-01-31'); // gone before the year began
    await asset(STOCKED, 4, 'sum_of_years', '2026-04-01', null); // bought after the year end
    await stockJournal('2025-10-15', 500);
  }, 120000);

  afterAll(async () => {
    try {
      await sql`DELETE FROM gl_journal_lines WHERE company_id = ANY(${[STOCKED, BARE]}::UUID[])`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ANY(${[STOCKED, BARE]}::UUID[])`;
      await sql`DELETE FROM gl_account_balances WHERE gl_account_id = ANY(${[inventory, bank]}::UUID[])`;
      await sql`DELETE FROM gl_accounts WHERE company_id = ANY(${[STOCKED, BARE]}::UUID[])`;
      await sql`DELETE FROM assets WHERE company_id = ANY(${[STOCKED, BARE]}::UUID[])`;
      await sql`DELETE FROM fiscal_periods WHERE company_id = ANY(${[STOCKED, BARE]}::UUID[])`;
      await sql`DELETE FROM company_users WHERE user_id = ${USER}`;
      await sql`DELETE FROM companies WHERE id = ANY(${[STOCKED, BARE]}::UUID[])`;
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

  it('states an inventories policy when inventory carries a balance at the year end', async () => {
    const { headings, snapshot } = await note1(STOCKED);
    expect(headings).toContain('Inventories');
    expect(snapshot.holds_inventory).toBe(true);
  });

  it('leaves the inventories policy out when the stock was bought after the year end', async () => {
    const { headings, snapshot } = await note1(STOCKED, 2025); // FY2025 ends 2025-02-28, before the purchase
    expect(headings).not.toContain('Inventories');
    expect(snapshot.holds_inventory).toBe(false);
  });

  it('a company with no assets and no stock: default depreciation text, no inventories policy, no other company\'s methods', async () => {
    const { headings, policy, snapshot } = await note1(BARE);
    expect(policy('Property, Plant and Equipment')).toContain('the straight-line method');
    expect(policy('Property, Plant and Equipment')).not.toMatch(/reducing-balance/);
    expect(headings).not.toContain('Inventories');
    expect(snapshot).toMatchObject({ depreciation_methods: [], holds_inventory: false, default_currency: 'ZAR' });
  });
});
