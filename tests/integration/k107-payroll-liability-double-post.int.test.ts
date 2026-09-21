/**
 * K-107 round 7 — the two payroll ledger writers the census never walked.
 *
 * The round-6 enumeration was complete over the set it looked at, and the set
 * omitted `services/payroll` and `services/loans` entirely. Two sites there
 * write the ledger off a status read:
 *
 *   `uifPaymentService.markUifDeclarationPaid` read `decl.status` in JS, posted
 *   DR 2150 UIF Payable / CR Bank, then rewrote `uif_declarations` with NO
 *   status predicate. Two concurrent `markPaid` PATCHes both read 'submitted',
 *   both posted and both COMMITted: the bank credited twice for one UI-19.
 *
 *   `taxDirectivePaymentService.applyTaxDirective` SELECTs
 *   `tax_directive_payments` for an existing row, then posts DR 5200 / CR 2140
 *   / CR bank and only then INSERTs the payment. The INSERT is the last thing
 *   it does, so the read is decorative under concurrency — the loser's journal
 *   is unwound by the 23505 rolling its transaction back, not refused before it
 *   posted. Now the payment row IS the claim, taken before the first posting.
 *
 * Proved by OUTCOME — the bank GL, not a journal count — under two interleaved
 * pool clients AND two sequential attempts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { markUifDeclarationPaid } from '../../src/modules/accounting/services/payroll/uifPaymentService';
import {
  applyTaxDirective,
  TaxDirectiveAlreadyAppliedError,
} from '../../src/modules/accounting/services/payroll/taxDirectivePaymentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID();
const uifPayable = crypto.randomUUID(), bank = crypto.randomUUID(), labour = crypto.randomUUID(), paye = crypto.randomUUID();

/** How long the winner holds its transaction open while the loser is parked. */
const HOLD_MS = 300;

const ctxFor = (client: PoolClient) =>
  ({ client, userId: user, companyId: company, claims: {} } as unknown as Parameters<typeof als.run>[0]);

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(ctxFor(client), fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** What an account actually moved, measured off POSTED journal lines. */
async function credited(account: string): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(jl.credit),0) AS c FROM gl_journal_lines jl
       JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id=$1 AND je.status='posted' AND jl.gl_account_id=$2`, [company, account]);
  return Number(r.rows[0].c);
}

let month = 0;
async function seedDeclaration(): Promise<string> {
  const id = crypto.randomUUID();
  month += 1;
  await pool.query(
    `INSERT INTO uif_declarations(id,company_id,period_year,period_month,total_employees,
       total_leviable_salary,total_employee_contribution,total_employer_contribution,status)
     VALUES($1,$2,2026,$3,4,100000,1000,1000,'submitted')`, [id, company, month]);
  return id;
}

async function seedDirective(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO tax_directives(id,company_id,employee_name,directive_type,amount,tax_rate,
       effective_date,status,directive_number)
     VALUES($1,$2,'K107 R7 employee','lump_sum',10000,0.18,'2026-03-01','approved',$3)`,
    [id, company, `K107R7-${id.slice(0, 8)}`]);
  return id;
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K107 R7 payroll fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active)
     VALUES($1,$2,'2150','UIF Payable','liability','other','credit',true),
            ($3,$2,'1110','Bank - Primary','asset','bank','debit',true),
            ($4,$2,'5200','Labour Costs','expense','other','debit',true),
            ($5,$2,'2140','PAYE Payable','liability','other','credit',true)`,
    [uifPayable, company, bank, labour, paye]);
});

afterAll(async () => {
  try {
    await pool.query('UPDATE uif_declarations SET journal_entry_id=NULL WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM tax_directive_payments WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM uif_declarations WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM tax_directives WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [company]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

// ─── markUifDeclarationPaid ──────────────────────────────────────────────────

it('UIF: credits the bank ONCE when two requests mark the same declaration paid simultaneously', async () => {
  const decl = await seedDeclaration();
  const before = await credited(bank);
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await als.run(ctxFor(a), () => markUifDeclarationPaid(company, decl, { paymentDate: '2026-03-07' }, user));

    let settled = false;
    const attempt = als.run(ctxFor(b), () => markUifDeclarationPaid(company, decl, { paymentDate: '2026-03-07' }, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    // A holds the declaration row: B is parked on the claim and cannot have
    // decided anything. Without the claim B was past the status read by now and
    // had already built its own journal.
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then((v) => v, () => null);
    await b.query('ROLLBACK');
    // Idempotent, as the pre-claim contract was: the loser reports the winner's
    // payment rather than posting a second one.
    expect.soft(loser?.status).toBe('paid');
  } finally { a.release(); b.release(); }

  expect.soft(await credited(bank) - before).toBeCloseTo(2000, 2);
  const row = await pool.query('SELECT status, journal_entry_id, payment_date FROM uif_declarations WHERE id=$1', [decl]);
  expect.soft(row.rows[0].status).toBe('paid');
  expect.soft(row.rows[0].payment_date).not.toBeNull();
  expect(row.rows[0].journal_entry_id).not.toBeNull();
});

it('UIF: the SEQUENTIAL second markPaid posts nothing', async () => {
  const decl = await seedDeclaration();
  const before = await credited(bank);
  const first = await inTx(() => markUifDeclarationPaid(company, decl, { paymentDate: '2026-03-07' }, user));
  const second = await inTx(() => markUifDeclarationPaid(company, decl, { paymentDate: '2026-03-07' }, user));

  expect.soft(second.journalEntryId).toBe(first.journalEntryId);
  expect(await credited(bank) - before).toBeCloseTo(2000, 2);
});

it('UIF: posts a balanced journal for the legitimate path and refuses a draft declaration', async () => {
  const decl = await seedDeclaration();
  await inTx(() => markUifDeclarationPaid(company, decl, { paymentDate: '2026-03-07' }, user));
  const je = await pool.query(
    `SELECT je.status, je.fiscal_period_id, COALESCE(SUM(jl.debit),0) dr, COALESCE(SUM(jl.credit),0) cr
       FROM gl_journal_entries je JOIN gl_journal_lines jl ON jl.journal_entry_id=je.id
       JOIN uif_declarations d ON d.journal_entry_id = je.id
      WHERE d.id=$1 GROUP BY je.id, je.status, je.fiscal_period_id`, [decl]);
  expect.soft(je.rowCount).toBe(1);
  expect.soft(je.rows[0].status).toBe('posted');
  expect.soft(je.rows[0].fiscal_period_id).not.toBeNull();
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(2000, 2);
  expect.soft(Number(je.rows[0].cr)).toBeCloseTo(2000, 2);

  const draft = await seedDeclaration();
  await pool.query("UPDATE uif_declarations SET status='draft' WHERE id=$1", [draft]);
  const before = await credited(bank);
  const err = await inTx(() => markUifDeclarationPaid(company, draft, { paymentDate: '2026-03-07' }, user))
    .then(() => null, (e: unknown) => e);
  expect.soft((err as Error).message).toMatch(/must be 'submitted'/);
  expect(await credited(bank)).toBeCloseTo(before, 2);
});

// ─── applyTaxDirective ───────────────────────────────────────────────────────

it('DIRECTIVE: credits the bank ONCE when two requests apply the same directive simultaneously', async () => {
  const directive = await seedDirective();
  const before = await credited(bank);
  const a = await pool.connect(), b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    await als.run(ctxFor(a), () => applyTaxDirective(company, directive, { paymentDate: '2026-03-07' }, user));

    let settled = false;
    const attempt = als.run(ctxFor(b), () => applyTaxDirective(company, directive, { paymentDate: '2026-03-07' }, user));
    attempt.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    expect.soft(settled).toBe(false);

    await a.query('COMMIT');
    const loser = await attempt.then(() => null, (e: unknown) => e);
    await b.query('ROLLBACK');
    expect.soft(loser).toBeInstanceOf(TaxDirectiveAlreadyAppliedError);
  } finally { a.release(); b.release(); }

  expect.soft(await credited(bank) - before).toBeCloseTo(8200, 2);
  const pay = await pool.query('SELECT journal_entry_id FROM tax_directive_payments WHERE tax_directive_id=$1', [directive]);
  expect.soft(pay.rowCount).toBe(1);
  expect(pay.rows[0].journal_entry_id).not.toBeNull();
});

it('DIRECTIVE: refuses the SEQUENTIAL second apply, posting nothing the second time', async () => {
  const directive = await seedDirective();
  const before = await credited(bank);
  await inTx(() => applyTaxDirective(company, directive, { paymentDate: '2026-03-07' }, user));

  const second = await inTx(() => applyTaxDirective(company, directive, { paymentDate: '2026-03-07' }, user))
    .then(() => null, (e: unknown) => e);
  expect.soft(second).toBeInstanceOf(TaxDirectiveAlreadyAppliedError);
  expect.soft(await credited(bank) - before).toBeCloseTo(8200, 2);
  expect(await credited(paye) - 0).toBeGreaterThan(0);
});

it('DIRECTIVE: posts a balanced journal agreeing with the payment on the legitimate path', async () => {
  const directive = await seedDirective();
  const result = await inTx(() => applyTaxDirective(company, directive, { paymentDate: '2026-03-07' }, user));
  expect.soft(result.gross).toBeCloseTo(10000, 2);
  expect.soft(result.paye).toBeCloseTo(1800, 2);
  expect.soft(result.net).toBeCloseTo(8200, 2);

  const je = await pool.query(
    `SELECT je.status, je.fiscal_period_id, COALESCE(SUM(jl.debit),0) dr, COALESCE(SUM(jl.credit),0) cr
       FROM gl_journal_entries je JOIN gl_journal_lines jl ON jl.journal_entry_id=je.id
       JOIN tax_directive_payments p ON p.journal_entry_id = je.id
      WHERE p.tax_directive_id=$1 GROUP BY je.id, je.status, je.fiscal_period_id`, [directive]);
  expect.soft(je.rowCount).toBe(1);
  expect.soft(je.rows[0].status).toBe('posted');
  expect.soft(je.rows[0].fiscal_period_id).not.toBeNull();
  expect.soft(Number(je.rows[0].dr)).toBeCloseTo(10000, 2);
  expect(Number(je.rows[0].cr)).toBeCloseTo(10000, 2);
});

it('DIRECTIVE: will not apply a directive belonging to another tenant', async () => {
  const other = crypto.randomUUID(), theirs = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'K107 R7 other']);
  await pool.query(
    `INSERT INTO tax_directives(id,company_id,employee_name,directive_type,amount,tax_rate,effective_date,status)
     VALUES($1,$2,'other employee','lump_sum',5000,0.18,'2026-03-01','approved')`, [theirs, other]);

  const err = await inTx(() => applyTaxDirective(company, theirs, { paymentDate: '2026-03-07' }, user))
    .then(() => null, (e: unknown) => e);
  expect.soft((err as Error).message).toMatch(/not found/);
  const pay = await pool.query('SELECT id FROM tax_directive_payments WHERE tax_directive_id=$1', [theirs]);
  expect(pay.rowCount).toBe(0);

  await pool.query('DELETE FROM tax_directives WHERE company_id=$1', [other]);
  await pool.query('DELETE FROM companies WHERE id=$1', [other]);
});
