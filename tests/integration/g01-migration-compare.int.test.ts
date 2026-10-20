/**
 * G-01 final: the two migration balance comparisons (verifyBalances after an import, and the Sage comparison
 * report) summed lines over `LEFT JOIN gl_journal_entries ... AND je.status = 'posted'` with no gate on the
 * joined entry, so a DRAFT line was counted and the comparison showed a difference against a source that
 * matched the posted ledger. Both are ledger-to-ledger reconciliations of ALL time, and the source's balances
 * already carry the year's P&L rolled into retained income, so they INCLUDE the stored year-end close.
 *
 * (generateComparison also selected `sa.sage_account_id` and `sa.name`, columns sage_accounts does not have,
 * so it threw 42703 on every call; it now selects the real ones.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant } from './helpers/g01Fixture';
import { closeFiscalYear } from '../../src/modules/accounting/services/gl/yearEndCloseService';
import { verifyBalances } from '../../src/modules/accounting/services/core/migrationExecuteService';
import { generateComparison } from '../../src/modules/accounting/services/core/sageMigrationCompareService';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const t = newTenant();

/** Normal-side balance of an account over POSTED entries, the stored close included: what the source system holds. */
async function posted(accountId: string, credit: boolean): Promise<number> {
  const r = await pool.query(
    `SELECT SUM(jl.${credit ? 'credit - jl.debit' : 'debit - jl.credit'})::numeric AS n FROM gl_journal_lines jl
     JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
     WHERE je.company_id=$1 AND jl.gl_account_id=$2 AND je.status='posted'`, [t.company, accountId]);
  return Number(r.rows[0].n);
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `g01mc-${user}@test.local`]);
  await seedTenant(pool, t, user, 'G01 migration compare');
  // A DRAFT line on the bank and on revenue, then the year-end close of FY2025.
  const draft = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by)
     VALUES($1,$2,'DRAFT-1','2025-08-01',$3,'draft','manual','draft',$4)`, [draft, t.company, t.period.p25, user]);
  await pool.query(
    `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
     VALUES($1,$2,15,0,'d',$4),($1,$3,0,15,'d',$4)`, [draft, t.acct.bank, t.acct.revenue, t.company]);
  await closeFiscalYear(t.company, '2025', user);
  // The source system holds every account the ledger holds a balance on, mapped one to one.
  const accounts = await pool.query('SELECT id, account_code, normal_balance FROM gl_accounts WHERE company_id=$1', [t.company]);
  for (const a of accounts.rows) {
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,gl_account_id,mapping_status)
       VALUES(gen_random_uuid(),$1,$2,$3,'sage',$4,$5,'mapped')`,
      [t.company, `S-${a.account_code}`, a.account_code, (await posted(a.id, a.normal_balance === 'credit')) || 0, a.id]);
  }
}, 120000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM gl_migration_comparisons WHERE company_id=$1', [t.company]);
    await pool.query('DELETE FROM sage_accounts WHERE company_id=$1', [t.company]);
    await cleanupTenant(pool, t);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('a source that matches the posted ledger compares as matching', () => {
  it('verifyBalances: no difference on the bank (a draft line) or on revenue (a draft line; the stored close is counted)', async () => {
    const results = await verifyBalances(t.company, [
      { sourceCode: '1000', sourceName: 'Bank', sourceType: 'asset', openingBalance: await posted(t.acct.bank, false) },
      { sourceCode: '4000', sourceName: 'Sales', sourceType: 'revenue', openingBalance: await posted(t.acct.revenue, true) },
    ]);
    expect(results.map((r) => [r.accountCode, r.difference, r.matched])).toEqual([['1000', 0, true], ['4000', 0, true]]);
  });

  it('generateComparison: the Sage report shows no differences and is balanced', async () => {
    const report = await generateComparison(t.company, user);
    expect(report.differences).toEqual([]);
    expect(report.isBalanced).toBe(true);
  });
});

describe('a source that carries balances the mapping does not reach', () => {
  const find = async () => generateComparison(t.company, user);

  it('an unmapped Sage account with a balance is a difference, and the report is not balanced', async () => {
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,mapping_status)
       VALUES(gen_random_uuid(),$1,'S-9999','9999','Sage only',500,'unmapped')`, [t.company]);
    const report = await find();
    expect(report.isBalanced).toBe(false);
    expect(report.differences).toEqual([
      expect.objectContaining({ accountCode: '9999', sageBalance: 500, glBalance: 0, difference: 500, kind: 'sage_unmapped' }),
    ]);
    expect(report.differences[0]!.accountName).toMatch(/Sage only.*no GL account mapped/);
  });

  it('an unmapped Sage account with no balance is not', async () => {
    await pool.query("UPDATE sage_accounts SET balance = 0 WHERE company_id=$1 AND sage_id='S-9999'", [t.company]);
    const report = await find();
    expect(report.differences).toEqual([]);
    expect(report.isBalanced).toBe(true);
  });

  it('a GL account with a balance and no Sage account mapped to it is a difference', async () => {
    await pool.query("DELETE FROM sage_accounts WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.capital]);
    const report = await find();
    expect(report.isBalanced).toBe(false);
    expect(report.differences).toEqual([
      expect.objectContaining({ accountCode: '3000', sageBalance: 0, glBalance: await posted(t.acct.capital, true), kind: 'gl_unmapped' }),
    ]);
    expect(report.differences[0]!.difference).toBe(-(await posted(t.acct.capital, true)));
    // Put the source's capital account back for the cases after this one.
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,gl_account_id,mapping_status)
       VALUES(gen_random_uuid(),$1,'S-3000','3000','sage',$2,$3,'mapped')`, [t.company, await posted(t.acct.capital, true), t.acct.capital]);
  });
});

describe('several Sage accounts mapped to one GL account', () => {
  const bankCode = '1000';

  it('are summed before they are compared: one difference per GL account, none when the sum matches', async () => {
    const bank = Number((await pool.query("SELECT balance FROM sage_accounts WHERE company_id=$1 AND account_code=$2 AND gl_account_id=$3", [t.company, bankCode, t.acct.bank])).rows[0].balance);
    // Split the bank's Sage balance over two Sage accounts that both map to it.
    await pool.query("UPDATE sage_accounts SET balance=$3 WHERE company_id=$1 AND gl_account_id=$2", [t.company, t.acct.bank, bank - 40]);
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,gl_account_id,mapping_status)
       VALUES(gen_random_uuid(),$1,'S-1000b','1000b','Bank (second)',40,$2,'mapped')`, [t.company, t.acct.bank]);
    const matching = await generateComparison(t.company, user);
    expect(matching.differences).toEqual([]);
    expect(matching.isBalanced).toBe(true);

    await pool.query("UPDATE sage_accounts SET balance=balance+7 WHERE company_id=$1 AND sage_id='S-1000b'", [t.company]);
    const off = await generateComparison(t.company, user);
    expect(off.differences).toEqual([
      expect.objectContaining({ accountCode: bankCode, sageBalance: bank + 7, glBalance: bank, difference: 7 }),
    ]);
  });
});

describe('a Sage account mapped to a GL account the comparison does not list as a leaf', () => {
  it('is still compared: a Sage balance on a level-2 account is a difference, not a "balanced" report', async () => {
    // Back to the matching state left by the case above.
    await pool.query("UPDATE sage_accounts SET balance=balance-7 WHERE company_id=$1 AND sage_id='S-1000b'", [t.company]);
    expect((await generateComparison(t.company, user)).differences).toEqual([]);

    const header = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
       VALUES($1,$2,'1900','Other assets (header)','asset','debit',2,true)`, [header, t.company]);
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,gl_account_id,mapping_status)
       VALUES(gen_random_uuid(),$1,'S-1900','1900','Sage header',25,$2,'manual')`, [t.company, header]);
    const report = await generateComparison(t.company, user);
    expect(report.isBalanced).toBe(false);
    expect(report.differences).toEqual([
      expect.objectContaining({ accountCode: '1900', accountName: 'Other assets (header)', sageBalance: 25, glBalance: 0, difference: 25 }),
    ]);
  });

  it('and so is one on an account at the DEFAULT level (a flat chart never given a hierarchy)', async () => {
    const flat = crypto.randomUUID();
    // No level column: gl_accounts.level defaults to 1.
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active)
       VALUES($1,$2,'1950','Flat chart account','asset','debit',true)`, [flat, t.company]);
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,gl_account_id,mapping_status)
       VALUES(gen_random_uuid(),$1,'S-1950','1950','Sage flat',60,$2,'manual')`, [t.company, flat]);
    expect((await pool.query('SELECT level FROM gl_accounts WHERE id=$1', [flat])).rows[0].level).toBe(1);
    const report = await generateComparison(t.company, user);
    expect(report.differences).toContainEqual(
      expect.objectContaining({ accountCode: '1950', sageBalance: 60, glBalance: 0, difference: 60 }));
  });
});

describe('header accounts that carry their own posted lines', () => {
  const left = crypto.randomUUID();
  const right = crypto.randomUUID();
  const entry = crypto.randomUUID();

  it('a level-1 account with posted lines and no Sage mapping is reported as gl_unmapped, with its real balance', async () => {
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
       VALUES($1,$3,'1960','Level one debit','asset','debit',1,true),($2,$3,'2960','Level one credit','liability','credit',1,true)`,
      [left, right, t.company]);
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
       VALUES($1,$2,'HDR-1','2026-03-01',$3,'header lines','manual','posted',$4,$4,now())`, [entry, t.company, t.period.p26, user]);
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,40,0,'h',$4),($1,$3,0,40,'h',$4)`, [entry, left, right, t.company]);
    const before = await generateComparison(t.company, user);
    expect(before.differences).toContainEqual(expect.objectContaining({ accountCode: '1960', sageBalance: 0, glBalance: 40, difference: -40, kind: 'gl_unmapped' }));
    expect(before.differences).toContainEqual(expect.objectContaining({ accountCode: '2960', glBalance: 40, kind: 'gl_unmapped' }));
  });

  it('a level-1 account mapped to a Sage row compares against its real balance, and totals count each line once', async () => {
    const totals = async () => (await generateComparison(t.company, user)).glTotals;
    const base = await totals();
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,gl_account_id,mapping_status)
       VALUES(gen_random_uuid(),$1,'S-1960','1960','Sage level one',40,$2,'manual')`, [t.company, left]);
    const matched = await generateComparison(t.company, user);
    expect(matched.differences.find((d) => d.accountCode === '1960')).toBeUndefined();
    await pool.query("UPDATE sage_accounts SET balance=55 WHERE company_id=$1 AND sage_id='S-1960'", [t.company]);
    const off = await generateComparison(t.company, user);
    expect(off.differences).toContainEqual(expect.objectContaining({ accountCode: '1960', sageBalance: 55, glBalance: 40, difference: 15 }));
    // Own lines only: mapping does not change the ledger totals, and debits equal credits.
    expect(await totals()).toEqual(base);
    expect(base.totalDebit).toBeCloseTo(base.totalCredit, 2);
    await pool.query("DELETE FROM sage_accounts WHERE company_id=$1 AND sage_id='S-1960'", [t.company]);
  });
});

describe('glTotals.accountCount: leaves, plus any header with posted activity', () => {
  it('counts a level-3 account with no lines, not a level-1 one with none, nor a header whose only line is a draft', async () => {
    const count = async () => (await generateComparison(t.company, user)).glTotals.accountCount;
    const base = await count();
    const [emptyHeader, emptyLeaf, draftHeader, entry] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
       VALUES($1,$2,'1970','Empty level one','asset','debit',1,true)`, [emptyHeader, t.company]);
    expect(await count()).toBe(base);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
       VALUES($1,$2,'1971','Empty level three','asset','debit',3,true)`, [emptyLeaf, t.company]);
    expect(await count()).toBe(base + 1);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
       VALUES($1,$2,'1972','Draft-only level two','asset','debit',2,true)`, [draftHeader, t.company]);
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by)
       VALUES($1,$2,'DRAFT-HDR','2026-03-02',$3,'draft','manual','draft',$4)`, [entry, t.company, t.period.p26, user]);
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,9,0,'d',$4),($1,$3,0,9,'d',$4)`, [entry, draftHeader, t.acct.bank, t.company]);
    expect(await count()).toBe(base + 1);
    // Once a level-1 account carries a posted line it counts, whichever side the line is on.
    const [posted1, debitHeader] = [crypto.randomUUID(), crypto.randomUUID()];
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
       VALUES($1,$2,'1973','Debited level one','asset','debit',1,true)`, [debitHeader, t.company]);
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
       VALUES($1,$2,'HDR-2','2026-03-03',$3,'header line','manual','posted',$4,$4,now())`, [posted1, t.company, t.period.p26, user]);
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id)
       VALUES($1,$2,6,0,'h',$4),($1,$3,0,6,'h',$4)`, [posted1, debitHeader, emptyHeader, t.company]);
    expect(await count()).toBe(base + 3);
  });
});

describe('the edges of what the mapping can point at', () => {
  const foreignCompany = crypto.randomUUID();
  const foreignGl = crypto.randomUUID();

  afterAll(async () => {
    await pool.query('DELETE FROM sage_accounts WHERE company_id=$1 AND sage_id=$2', [t.company, 'S-FOREIGN']);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [foreignCompany]);
    await pool.query('DELETE FROM companies WHERE id=$1', [foreignCompany]);
  });

  it("a Sage row pointing at ANOTHER company's GL account is reported as unmapped and matches nothing", async () => {
    await pool.query('INSERT INTO companies(id,name,financial_year_start) VALUES($1,$2,1)', [foreignCompany, 'G01 foreign']);
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level,is_active)
       VALUES($1,$2,'7777','Foreign bank','asset','debit',3,true)`, [foreignGl, foreignCompany]);
    await pool.query(
      `INSERT INTO sage_accounts(id,company_id,sage_id,account_code,account_name,balance,gl_account_id,mapping_status)
       VALUES(gen_random_uuid(),$1,'S-FOREIGN','7777','Sage foreign',0,$2,'manual')`, [t.company, foreignGl]);
    // A zero balance would hide a match; give it one equal to nothing the tenant holds.
    await pool.query("UPDATE sage_accounts SET balance=77 WHERE company_id=$1 AND sage_id='S-FOREIGN'", [t.company]);
    const report = await generateComparison(t.company, user);
    expect(report.differences).toContainEqual(
      expect.objectContaining({ accountCode: '7777', sageBalance: 77, glBalance: 0, kind: 'sage_unmapped' }));
    expect(report.differences.find((d) => d.accountName === 'Foreign bank')).toBeUndefined();
  });

  it('with no Sage accounts at all, every ledger balance is a difference and nothing is balanced', async () => {
    await pool.query('DELETE FROM sage_accounts WHERE company_id=$1', [t.company]);
    const report = await generateComparison(t.company, user);
    expect(report.sageTotals.accountCount).toBe(0);
    expect(report.isBalanced).toBe(false);
    expect(report.differences.length).toBeGreaterThan(0);
    expect(report.differences.every((d) => d.kind === 'gl_unmapped')).toBe(true);
  });
});
