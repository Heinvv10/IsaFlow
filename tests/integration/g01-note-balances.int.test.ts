/**
 * G-01 final round: four AFS note queries (Notes 5, 9, 11 and the disclosure cash note) put the entry's
 * conditions in the ON clause of a LEFT JOIN onto gl_journal_entries but summed the LINES unguarded, so a
 * line whose entry failed the ON (a DRAFT, an entry dated after the year end, the posted year-end close)
 * was summed anyway. The conditions must exclude lines, not just blank the entry's columns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant } from './helpers/g01Fixture';
import { generateNote5IntangibleAssets } from '../../src/modules/accounting/services/afs/noteGenerators/notes1to5';
import { generateNote9Inventories } from '../../src/modules/accounting/services/afs/noteGenerators/notes6to10';
import { generateNote11CashAndCashEquivalents } from '../../src/modules/accounting/services/afs/noteGenerators/notes11to15';
import { noteCash } from '../../src/modules/accounting/services/reports/disclosureNoteGenerators';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const t = newTenant();
const intangible = crypto.randomUUID();
const inventory = crypto.randomUUID();

async function entry(n: string, date: string, status: 'posted' | 'draft', left: string, right: string, amount: number) {
  const id = crypto.randomUUID();
  // The period holding the date (migration 941): FY2025's, or FY2026's for an entry after the year end.
  const period = date.startsWith('2026-') ? t.period.p26 : t.period.p25;
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by)
     VALUES($1,$2,$3,$4,$5,'seed','manual',$6,$7)`, [id, t.company, n, date, period, status, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,$4,0,'seed',$5),($1,$3,0,$4,'seed',$5)`, [id, left, right, amount, t.company]);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01nb-${user}@test.local`]);
  await seedTenant(pool, t, user, 'G01 note balances');
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$3,'1500','Software','asset','intangible_asset','debit',true,false),
            ($2,$3,'1300','Stock','asset','inventory','debit',true,false)`, [intangible, inventory, t.company]);
  // Posted inside FY2025: the balance. A DRAFT and an entry dated AFTER the year end must not count.
  await entry('IN-1', '2025-06-01', 'posted', intangible, t.acct.bank, 311);
  await entry('IN-D', '2025-07-01', 'draft', intangible, t.acct.bank, 71);
  await entry('IN-L', '2026-02-01', 'posted', intangible, t.acct.bank, 41);
  await entry('ST-1', '2025-06-02', 'posted', inventory, t.acct.bank, 322);
  await entry('ST-D', '2025-07-02', 'draft', inventory, t.acct.bank, 72);
  await entry('ST-L', '2026-02-02', 'posted', inventory, t.acct.bank, 42);
  await entry('CA-D', '2025-07-03', 'draft', t.acct.bank, t.acct.capital, 15);
}, 120000);

afterAll(async () => {
  try {
    await cleanupTenant(pool, t);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

const balances = (snapshot: unknown): number[] =>
  (Object.values(snapshot as Record<string, unknown>).flat() as Array<{ balance?: unknown }>)
    .map((r) => Number(r.balance)).filter((n) => Number.isFinite(n));

describe('note balances are the posted entries to the year end', () => {
  it('Note 5 (intangible assets)', async () => {
    expect(balances((await generateNote5IntangibleAssets(t.company, 2025)).dataSnapshot)).toEqual([311]);
  });

  it('Note 9 (inventories)', async () => {
    expect(balances((await generateNote9Inventories(t.company, 2025)).dataSnapshot)).toEqual([322]);
  });

  const postedBank = async (): Promise<number> => {
    const r = await pool.query(
      `SELECT SUM(jl.debit - jl.credit)::numeric AS n FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id=jl.journal_entry_id
       WHERE je.company_id=$1 AND jl.gl_account_id=$2 AND je.status='posted' AND je.entry_date <= '2025-12-31'`, [t.company, t.acct.bank]);
    return Number(r.rows[0].n);
  };

  it('Note 11 (cash): the ledger at 31 Dec 2025, no draft, nothing after it', async () => {
    expect(balances((await generateNote11CashAndCashEquivalents(t.company, 2025)).dataSnapshot)).toEqual([await postedBank()]);
  });

  it('the disclosure cash note', async () => {
    const total = (await noteCash(t.company, 2025)).tables![0]!.rows.at(-1)![2]!;
    // "15 817,00" (South African grouping) -> 15817.00
    expect(Number(total.replace(/[\s\u00a0]/g, '').replace(',', '.'))).toBe(await postedBank());
  });
});
