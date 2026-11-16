/**
 * WP1 PR-B: the grouped bank ledger (`bankGlBalancesAsAt`, the bank card) answers exactly what the per-account one
 * (`bankGlBalanceAsAt`, the reconciliation, K-020) answers, for several accounts and dates — and both answer the
 * hand-computed figures, so a change to their shared statement (`postedBankLedgerSum`) shows in BOTH.
 *
 * Fixture (cents): bank DR 100 000 on 01-15, CR 25 050 on 06-30, a 7 777 DR left a DRAFT on 07-01, DR 1 000 on 12-31;
 * bank 2 DR 50 000 on 03-01, CR 12 525 on 09-15; a credit card (liability) CR 150 000 on 09-10; an empty bank account;
 * and another company's posted journal on its own bank account. Read as app_user under RLS.
 *
 * Review round 2 (PR #1475): both forms equal the Trial Balance bank row BY CONSTRUCTION — a posted `year_end`
 * journal on the bank (DR 33 333 on 12-31) is in neither (the TB leaves the close out), and an account whose lines
 * carry NULL in one column (`debit`/`credit` are nullable) answers its real figure, not 0.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { bankGlBalanceAsAt, bankGlBalancesAsAt } from '@/modules/accounting/services/bank/bankReconciliationBalance';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser } from './r035-approval.helpers';
import { asToken, bankCompany, cleanupBankControlsA, type BankCompany } from './bank-controls-a.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let u = '';
let f: BankCompany;
let other: BankCompany;
const acct = { bank: '', bank2: '', card: '', empty: '', nulls: '' };

const DATES = ['2025-12-31', '2026-01-15', '2026-06-29', '2026-06-30', '2026-09-15', '2026-12-31'] as const;
const EXPECTED: Record<keyof typeof acct, number[]> = {
  bank: [0, 100000, 100000, 74950, 74950, 75950],
  bank2: [0, 0, 50000, 50000, 37475, 37475],
  card: [0, 0, 0, 0, -150000, -150000],
  empty: [0, 0, 0, 0, 0, 0],
  nulls: [0, 0, 0, 0, 4000, 4000],
};

async function journal(c: BankCompany, date: string, debit: string, credit: string, amount: number, status = 'posted',
  source = 'manual') {
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by)
     VALUES($1,$2,$3::DATE,'WP1 grouped',$5,'draft',$4) RETURNING id`,
    [c.c, `JE-${crypto.randomUUID().slice(0, 8)}`, date, u, source])).rows[0].id as string;
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
     VALUES($1,$2,$3,$5,0,'dr'),($1,$2,$4,0,$5,'cr')`, [c.c, je, debit, credit, amount]);
  if (status !== 'draft') await pool.query('UPDATE gl_journal_entries SET status = $2 WHERE id = $1', [je, status]);
}

const toCents = (v: unknown) => Math.round(Number(v) * 100);
const perAccount = (account: string, date: string) => asToken(pool, u, f.c, async () =>
  toCents(((await bankGlBalanceAsAt(f.c, sql`${account}::UUID`, sql`${date}::DATE`)) as { gl_balance: string }[])[0]!.gl_balance));

/** The grouped form over `pairs`, as a Map "account|date" → cents; an absent pair is 0. */
async function grouped(pairs: [string, string][]): Promise<(account: string, date: string) => number> {
  const rows = await asToken(pool, u, f.c, async () => (await sql`${bankGlBalancesAsAt(f.c, sql`
    SELECT x.account_id::UUID AS account_id, x.as_at::DATE AS as_at
    FROM unnest(${pairs.map((p) => p[0])}::TEXT[], ${pairs.map((p) => p[1])}::TEXT[]) AS x(account_id, as_at)`)}`) as
    { account_id: string; as_at: string | Date; gl_balance: string }[]);
  const iso = (d: string | Date) => (d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d);
  const map = new Map(rows.map((r) => [`${r.account_id}|${iso(r.as_at)}`, toCents(r.gl_balance)]));
  expect(map.size).toBe(rows.length); // one row per pair
  return (account, date) => map.get(`${account}|${date}`) ?? 0;
}

beforeAll(async () => {
  u = await createUser(pool, tokens);
  f = await bankCompany(pool, [[u, 'admin']], companies);
  other = await bankCompany(pool, [[u, 'admin']], companies);
  const bank = async (code: string, type = 'asset', normal = 'debit') => (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES ($1,$2,$3,$4,$5,true,'bank') RETURNING id`, [f.c, code, `WP1 ${code}`, type, normal])).rows[0].id as string;
  Object.assign(acct, { bank: f.bank, bank2: f.bank2, card: await bank(`GC${f.c.slice(0, 4)}`, 'liability', 'credit'),
    empty: await bank(`GE${f.c.slice(0, 4)}`), nulls: await bank(`GN${f.c.slice(0, 4)}`) });
  await journal(f, '2026-01-15', acct.bank, f.expA, 1000.00);
  await journal(f, '2026-06-30', f.expA, acct.bank, 250.50);
  await journal(f, '2026-07-01', acct.bank, f.expA, 77.77, 'draft');
  await journal(f, '2026-12-31', acct.bank, f.expA, 10.00);
  await journal(f, '2026-03-01', acct.bank2, f.expB, 500.00);
  await journal(f, '2026-09-15', f.expB, acct.bank2, 125.25);
  await journal(f, '2026-09-10', f.expA, acct.card, 1500.00);
  await journal(other, '2026-02-01', other.bank, other.expA, 8888.88);
  // The close: posted, source 'year_end', touching the bank (the TB leaves it out).
  await journal(f, '2026-12-31', acct.bank, f.expA, 333.33, 'posted', 'year_end');
  // Every line of the 'nulls' account leaves credit NULL (the contra leaves debit NULL): DR 40.00 on 09-01.
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries(company_id,entry_number,entry_date,description,source,status,created_by)
     VALUES($1,$2,DATE '2026-09-01','WP1 nulls','manual','draft',$3) RETURNING id`,
    [f.c, `JE-${crypto.randomUUID().slice(0, 8)}`, u])).rows[0].id as string;
  await pool.query(
    `INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,description)
     VALUES($1,$2,$3,40.00,NULL,'dr'),($1,$2,$4,NULL,40.00,'cr')`, [f.c, je, acct.nulls, f.expB]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted' WHERE id = $1", [je]);
}, 60000);

afterAll(async () => { await cleanupBankControlsA(pool, companies, [u]); });

describe('bank ledger: grouped = per account = hand-computed', () => {
  const names = Object.keys(EXPECTED) as (keyof typeof acct)[];

  it('bankGlBalanceAsAt (the reconciliation\'s) answers the hand-computed figures', async () => {
    for (const name of names) {
      const got = [];
      for (const d of DATES) got.push(await perAccount(acct[name], d));
      expect(got, name).toEqual(EXPECTED[name]);
    }
  });

  it('bankGlBalancesAsAt over every (account, date) pair answers the same figures in one pass', async () => {
    const at = await grouped(names.flatMap((n) => DATES.map((d): [string, string] => [acct[n], d])));
    for (const name of names) expect(DATES.map((d) => at(acct[name], d)), name).toEqual(EXPECTED[name]);
  });

  it('with one date per account (the statement-date shape), grouped equals per-account for each', async () => {
    const pairs: [string, string][] = [[acct.bank, '2026-06-30'], [acct.bank2, '2026-09-15'], [acct.card, '2026-09-10'],
      [acct.empty, '2026-12-31']];
    const at = await grouped(pairs);
    for (const [account, date] of pairs) expect(at(account, date), `${account} ${date}`).toBe(await perAccount(account, date));
    expect(pairs.map(([a, d]) => at(a, d))).toEqual([74950, 37475, -150000, 0]);
  });

  it('both equal the Trial Balance bank rows at period end: the year_end journal left out, NULL columns counted', async () => {
    const period = (await pool.query('SELECT id FROM fiscal_periods WHERE company_id = $1', [f.c])).rows[0].id as string;
    const tb = await asToken(pool, u, f.c, () => getTrialBalance(f.c, period));
    const codes = new Map((await pool.query('SELECT id, account_code FROM gl_accounts WHERE company_id = $1', [f.c]))
      .rows.map((r) => [String(r.id), String(r.account_code)]));
    const tbCents = (account: string) => {
      const row = tb.find((r) => r.accountCode === codes.get(account));
      return row ? Math.round(row.debitBalance * 100) - Math.round(row.creditBalance * 100) : 0;
    };
    const at = await grouped(names.map((n): [string, string] => [acct[n], '2026-12-31']));
    for (const name of names) {
      expect({ name, tb: tbCents(acct[name]), per: await perAccount(acct[name], '2026-12-31'), grouped: at(acct[name], '2026-12-31') })
        .toEqual({ name, tb: EXPECTED[name][5], per: EXPECTED[name][5], grouped: EXPECTED[name][5] });
    }
  });

  it('another company\'s journals are in neither: its bank asked through this company answers 0', async () => {
    expect(await perAccount(other.bank, '2026-12-31')).toBe(0);
    expect((await grouped([[other.bank, '2026-12-31']]))(other.bank, '2026-12-31')).toBe(0);
  });
});
