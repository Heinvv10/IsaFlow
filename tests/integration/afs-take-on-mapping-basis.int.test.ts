/**
 * The income statement's "Balances taken on" line (ISTAKEON) picks its accounts
 * by AFS mapping, like BS045 and the AFS SOCE's "Balances taken on" column, not
 * by account subtype (round 10, F1). The dev case: Britech's Sage take-on sits
 * on "Retained Income (Opening Balance)", subtype equity; mapped to BS045, the
 * SOCE and BS045 carry it, so ISTAKEON must too. And a retained_earnings
 * account mapped elsewhere (here BS043) is on neither, so not on ISTAKEON.
 *
 * G-01 fixture tenant. FY2025: a take-on of 100 onto the subtype-equity account
 * mapped to BS045, dated the last day of the year (the range includes its end).
 * FY2026: a take-on of 200 onto a retained_earnings account mapped to BS043.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { newTenant, seedTenant, cleanupTenant } from './helpers/g01Fixture';
import { generateChangesInEquity } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/equity';
import { generateIncomeStatement } from '../../src/modules/accounting/services/afs/noteGenerators/primaryStatements/incomeStatement';
import { fmt } from '../../src/modules/accounting/services/afs/noteGenerators/noteHelpers';

assertDisposable();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = crypto.randomUUID();
const t = newTenant();
const openingRe = crypto.randomUUID(); // subtype equity, mapped BS045
const otherRe = crypto.randomUUID(); // subtype retained_earnings, mapped BS043

async function takeOn(n: string, date: string, period: string, account: string, amount: number) {
  const entry = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,fiscal_period_id,description,source,status,created_by,posted_by,posted_at)
     VALUES($1,$2,$3,$4,$5,'take-on','auto_migration','posted',$6,$6,now())`, [entry, t.company, n, date, period, user]);
  for (const [acct, debit, credit] of [[t.acct.bank, amount, 0], [account, 0, amount]] as const) {
    await pool.query(
      `INSERT INTO gl_journal_lines(journal_entry_id,gl_account_id,debit,credit,description,company_id) VALUES($1,$2,$3,$4,'line',$5)`,
      [entry, acct, debit, credit, t.company]);
  }
}

beforeAll(async () => {
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `afsmapbasis-${user}@test.local`]);
  await seedTenant(pool, t, user, 'AFS take-on mapping basis');
  for (const [id, code, name, subtype, line] of [
    [openingRe, '3910', 'Retained Income (Opening Balance)', 'equity', 'BS045'],
    [otherRe, '3920', 'Old retained earnings', 'retained_earnings', 'BS043'],
  ] as const) {
    await pool.query(
      `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
       VALUES($1,$2,$3,$4,'equity',$5,'credit',true,false,3)`, [id, t.company, code, name, subtype]);
    await pool.query('INSERT INTO afs_account_mappings(company_id,gl_account_id,afs_line_code) VALUES($1,$2,$3)', [t.company, id, line]);
  }
  await takeOn('TAKEON25', '2025-12-31', t.period.p25, openingRe, 100);
  await takeOn('TAKEON26', '2026-03-31', t.period.p26, otherRe, 200);
}, 120000);

afterAll(async () => {
  try {
    await cleanupTenant(pool, t);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

interface Line { code: string; currentAmount: number; priorAmount: number }
const takenOn = async (year: number) => {
  const lines = (await generateIncomeStatement(t.company, year, 'ifrs_smes')).dataSnapshot.lines as Line[];
  return lines.find((l) => l.code === 'ISTAKEON')!;
};

describe('ISTAKEON by AFS mapping', () => {
  it('counts a take-on on a subtype-equity account mapped to BS045, as the AFS SOCE does', async () => {
    expect((await takenOn(2025)).currentAmount).toBe(-100); // raw: credit-positive 100
    const soce = await generateChangesInEquity(t.company, 2025, 'ifrs_smes');
    const table = soce.content.blocks.find((x) => x.type === 'table') as { headers: string[]; rows: string[][] };
    const accumulated = table.rows.find((r) => r[0] === 'Accumulated profit (loss)')!;
    expect(accumulated[table.headers.indexOf('Balances taken on (R)')]).toBe(fmt(100));
  });

  it('leaves out a take-on on a retained_earnings account mapped elsewhere', async () => {
    const line = await takenOn(2026);
    expect(line.currentAmount).toBeCloseTo(0, 2);
    expect(line.priorAmount).toBe(-100); // the FY2025 take-on, in the comparative column
  });
});
