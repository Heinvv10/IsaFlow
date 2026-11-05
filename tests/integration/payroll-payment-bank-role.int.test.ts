/**
 * The UIF payment, the SARS directive payment and the loan instalment credit
 * the account holding the company's BANK system role when no bankAccountId is
 * supplied (they credited the literal code 1110: Velocity Fibre moved the role
 * off 1110 on 2026-10-27), and check a supplied bankAccountId: it must be an
 * active bank account of THIS company.
 *
 * A refusal (BankAccountRefusedError, a 400 on the routes) is raised before the
 * claim each service takes, so a refused UIF declaration is still 'submitted',
 * a refused directive has no payment row and a refused loan no payment.
 *
 * Disposable DB only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '../../src/lib/als';
import { clearSystemAccountCache } from '../../src/modules/accounting/services/gl/systemAccountResolver';
import { BankAccountRefusedError } from '../../src/modules/accounting/services/gl/paymentBankAccount';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { markUifDeclarationPaid } from '../../src/modules/accounting/services/payroll/uifPaymentService';
import { applyTaxDirective, TaxDirectiveAlreadyAppliedError } from '../../src/modules/accounting/services/payroll/taxDirectivePaymentService';
import { recordLoanPayment } from '../../src/modules/accounting/services/loans/loanPaymentService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const id = () => crypto.randomUUID();
const company = id(), other = id(), user = id(), employee = id(), loan = id(), run = id(), loanAccount = id(), interestAccount = id();
const acct: Record<string, string> = {};

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
  } finally { client.release(); }
}

const credited = async (account: string): Promise<number> => Number((await pool.query(
  `SELECT COALESCE(SUM(jl.credit),0) AS c FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = $1 AND je.status = 'posted' AND jl.gl_account_id = $2`, [company, account])).rows[0].c);
const flag = async (code: string, patch: { system?: boolean; active?: boolean }) => {
  await pool.query(
    `UPDATE gl_accounts SET is_system_account = COALESCE($3, is_system_account), is_active = COALESCE($4, is_active)
      WHERE company_id = $1 AND account_code = $2`, [company, code, patch.system ?? null, patch.active ?? null]);
  clearSystemAccountCache(company);
};

let month = 0;
const declaration = async (): Promise<string> => {
  const d = id(); month += 1;
  await pool.query(
    `INSERT INTO uif_declarations(id,company_id,period_year,period_month,total_employees,total_leviable_salary,
       total_employee_contribution,total_employer_contribution,status) VALUES($1,$2,2026,$3,4,100000,1000,1000,'submitted')`, [d, company, month]);
  return d;
};
const declStatus = async (d: string): Promise<string> => (await pool.query('SELECT status FROM uif_declarations WHERE id=$1', [d])).rows[0].status;
const directive = async (): Promise<string> => {
  const d = id();
  await pool.query(
    `INSERT INTO tax_directives(id,company_id,employee_id,employee_name,directive_type,amount,tax_rate,effective_date,status,directive_number)
     VALUES($1,$2,$3,'Bank role employee','lump_sum',10000,0.18,'2026-03-01','approved',$4)`, [d, company, employee, `BR-${d.slice(0, 8)}`]);
  return d;
};
const directivePayments = async (d: string): Promise<number> => Number((await pool.query(
  'SELECT count(*) AS n FROM tax_directive_payments WHERE tax_directive_id=$1', [d])).rows[0].n);
const loanPayments = async (): Promise<number> => Number((await pool.query('SELECT count(*) AS n FROM loan_payments WHERE loan_id=$1', [loan])).rows[0].n);


const payUif = async (bankAccountId?: string) => { const d = await declaration(); return { d, p: inTx(() => markUifDeclarationPaid(company, d, { paymentDate: '2026-03-07', bankAccountId }, user)) }; };
let period = 0;
const payLoan = (bankAccountId?: string) => { period += 1; return inTx(() => recordLoanPayment(company, loan, { paymentDate: '2026-02-01', periodNumber: period, bankAccountId }, user)); };

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2),($3,$4)', [company, 'Payment bank role', other, 'Payment bank role (other tenant)']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query(
    `INSERT INTO payroll_employees (id, company_id, employee_number, first_name, last_name, start_date, medical_aid_main_member)
     VALUES ($1, $2, 'BR-1', 'Bank', 'Role', '2020-01-01', true)`, [employee, company]);
  const rows: Array<[string, string, string, string, string | null, boolean, string]> = [
    ['1110', 'Bank - Primary', 'asset', 'debit', 'bank', true, company],
    ['1544331', 'ABSA Cheque', 'asset', 'debit', 'bank', false, company],
    ['1120', 'Savings', 'asset', 'debit', 'bank', false, company],
    ['2150', 'UIF Payable', 'liability', 'credit', 'other', false, company],
    ['2140', 'PAYE Payable', 'liability', 'credit', 'other', false, company],
    ['5200', 'Labour Costs', 'expense', 'debit', 'other', false, company],
    ['1110', 'Their bank', 'asset', 'debit', 'bank', true, other],
  ];
  for (const [code, name, type, nb, sub, sys, co] of rows) {
    const aid = (await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,account_subtype,is_system_account,is_active,level)
       VALUES($1,$2,$3,$4,$5,$6,$7,true,3) RETURNING id`, [co, code, name, type, nb, sub, sys])).rows[0].id as string;
    acct[co === other ? `other-${code}` : code] = aid;
  }
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
     VALUES($1,$2,'2300','Loan Payable','liability','other','credit',true,false),($3,$2,'5700','Bank Charges','expense','other','debit',true,false)`,
    [loanAccount, company, interestAccount]);
  await pool.query(
    `INSERT INTO loans(id,company_id,gl_account_id,reference,principal,start_date,term_months,rate_mode,fixed_rate,status)
     VALUES($1,$2,$3,'BR-LOAN',120000,'2026-01-01',12,'FIXED',0.10,'active')`, [loan, company, loanAccount]);
  await pool.query(`INSERT INTO loan_schedule_runs(id,loan_id,company_id,computed_at,engine_version,inputs_hash) VALUES($1,$2,$3,NOW(),'br','br')`, [run, loan, company]);
  for (let p = 1; p <= 12; p++) {
    await pool.query(
      `INSERT INTO loan_schedule_rows(run_id,period,date,opening,rate,installment,interest,principal,closing)
       VALUES($1,$2,'2026-02-01',120000,0.10,10500,1000,9500,110500)`, [run, p]);
  }
});

afterAll(async () => {
  try {
    const cos = [company, other];
    await pool.query('DELETE FROM loan_payments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM loan_schedule_rows WHERE run_id=$1', [run]);
    await pool.query('DELETE FROM loan_schedule_runs WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM loans WHERE company_id = ANY($1)', [cos]);
    await pool.query('UPDATE uif_declarations SET journal_entry_id=NULL WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM tax_directive_payments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM uif_declarations WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM tax_directives WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM payroll_employees WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ANY($1))', [cos]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

describe('regression: while 1110 holds the role, the payments credit 1110', () => {
  it('UIF, directive and loan', async () => {
    const before = await credited(acct['1110']!);
    await (await payUif()).p;
    await inTx(async () => applyTaxDirective(company, await directive(), { paymentDate: '2026-03-07' }, user));
    await payLoan();
    // UIF 2000 + directive net 8200 + loan 10500
    expect(await credited(acct['1110']!) - before).toBeCloseTo(2000 + 8200 + 10500, 2);
  });
});

describe('role moved off 1110: the default is the holder', () => {
  it('UIF, directive and loan credit 1544331 and leave 1110 alone', async () => {
    await flag('1110', { system: false, active: false });
    await flag('1544331', { system: true });
    const old = await credited(acct['1110']!);
    await (await payUif()).p;
    await inTx(async () => applyTaxDirective(company, await directive(), { paymentDate: '2026-03-08' }, user));
    await payLoan();
    expect(await credited(acct['1544331']!)).toBeCloseTo(2000 + 8200 + 10500, 2);
    expect(await credited(acct['1110']!)).toBeCloseTo(old, 2);
  });
});

describe('a supplied bankAccountId is checked', () => {
  const refusals: Array<[string, () => string]> = [
    ["another company's account", () => acct['other-1110']!],
    ['an account that is not a bank account', () => acct['2150']!],
    ['an unknown account', () => id()],
  ];
  describe.each(refusals)('%s', (_label, supplied) => {
    it('UIF: refused, and the declaration stays submitted', async () => {
      const d = await declaration();
      const err = await inTx(() => markUifDeclarationPaid(company, d, { paymentDate: '2026-03-07', bankAccountId: supplied() }, user)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BankAccountRefusedError);
      expect(await declStatus(d)).toBe('submitted');
    });
    it('directive: refused, and no payment row is claimed', async () => {
      const d = await directive();
      const err = await inTx(() => applyTaxDirective(company, d, { paymentDate: '2026-03-07', bankAccountId: supplied() }, user)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BankAccountRefusedError);
      expect(await directivePayments(d)).toBe(0);
    });
    it('loan: refused, and no payment is recorded', async () => {
      const before = await loanPayments();
      const err = await payLoan(supplied()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BankAccountRefusedError);
      expect(await loanPayments()).toBe(before);
    });
  });

  it('an active bank account of the company is credited, role holder or not', async () => {
    const savings = acct['1120']!;
    await (await payUif(savings)).p;
    await inTx(async () => applyTaxDirective(company, await directive(), { paymentDate: '2026-03-09', bankAccountId: savings }, user));
    await payLoan(savings);
    expect(await credited(savings)).toBeCloseTo(2000 + 8200 + 10500, 2);
  });
});

describe('no account holds the role', () => {
  it('all three are refused with the bank-role reason and claim nothing', async () => {
    await flag('1544331', { active: false });
    const d = await declaration();
    const uifErr = await inTx(() => markUifDeclarationPaid(company, d, { paymentDate: '2026-03-07' }, user)).catch((e: unknown) => e);
    const dir = await directive();
    const dirErr = await inTx(() => applyTaxDirective(company, dir, { paymentDate: '2026-03-07' }, user)).catch((e: unknown) => e);
    const loanBefore = await loanPayments();
    const loanErr = await payLoan().catch((e: unknown) => e);
    for (const e of [uifErr, dirErr, loanErr]) {
      expect(e).toBeInstanceOf(BankAccountRefusedError);
      expect((e as Error).message).toMatch(/bank role/);
    }
    expect(await declStatus(d)).toBe('submitted');
    expect(await directivePayments(dir)).toBe(0);
    expect(await loanPayments()).toBe(loanBefore);
    await flag('1544331', { active: true });
  });
});

describe('a retry on a payment already made is answered as before, whatever the bank is now', () => {
  it('UIF: a paid declaration stays idempotent after the role lost its holder', async () => {
    await flag('1544331', { active: true });
    const { d, p } = await payUif();
    const first = await p;
    await flag('1544331', { active: false });
    const again = await inTx(() => markUifDeclarationPaid(company, d, { paymentDate: '2026-03-07' }, user));
    expect(again).toMatchObject({ id: d, status: 'paid', journalEntryId: first.journalEntryId });
    const supplied = await inTx(() => markUifDeclarationPaid(company, d, { paymentDate: '2026-03-07', bankAccountId: acct['other-1110']! }, user));
    expect(supplied.status).toBe('paid');
  });

  it('directive: an applied directive is still "already applied" (409), not a bank refusal', async () => {
    await flag('1544331', { active: true });
    const d = await directive();
    await inTx(() => applyTaxDirective(company, d, { paymentDate: '2026-03-10' }, user));
    await flag('1544331', { active: false });
    const err = await inTx(() => applyTaxDirective(company, d, { paymentDate: '2026-03-10' }, user)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaxDirectiveAlreadyAppliedError);
    expect(await directivePayments(d)).toBe(1);
  });

  it('loan: a stored bank_account_id deactivated since is refused like a supplied one, and nothing is recorded', async () => {
    await flag('1544331', { active: true });
    await pool.query('UPDATE loans SET bank_account_id = $2 WHERE id = $1', [loan, acct['1120']]);
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [acct['1120']]);
    const before = await loanPayments();
    const err = await payLoan().catch((e: unknown) => e);
    await pool.query('UPDATE gl_accounts SET is_active = true WHERE id = $1', [acct['1120']]);
    expect(err).toBeInstanceOf(BankAccountRefusedError);
    expect((err as Error).message).toMatch(/1120 Savings is deactivated/);
    expect(await loanPayments()).toBe(before);
    await pool.query('UPDATE loans SET bank_account_id = NULL WHERE id = $1', [loan]);
  });
});

