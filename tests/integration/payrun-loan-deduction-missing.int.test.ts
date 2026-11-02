/**
 * The loan instalment is taken only on a DEDUCTION coded LOAN. With none active, a run must not
 * reduce the loan, flag its schedule row or record a payment it put on no payslip: it takes nothing,
 * says so on the line, and approval is refused until the deduction exists. A proper LOAN deduction
 * behaves as before. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import { calculatePayRunTool } from '../../src/lib/mcp/tools/writePayrollRun';
import { listPayrollComponentsTool } from '../../src/lib/mcp/tools/payrollComponents';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, line, header, preview, doApprove, recalculate, addLoan, addComponent } = fx;
const comp = state.comp;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

const loanState = async (loan: string) => ({
  balance: Number((await pool.query('SELECT outstanding_balance FROM payroll_loans WHERE id = $1', [loan])).rows[0]!.outstanding_balance),
  paidFlags: (await pool.query('SELECT paid_flag FROM payroll_loan_schedule WHERE loan_id = $1', [loan])).rows.map((r) => r.paid_flag),
  payments: Number((await pool.query('SELECT count(*) FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows[0]!.count),
});
const codes = (l: { validation_results: Array<{ code: string }> }) => l.validation_results.map((v) => v.code);
const withoutLoanDeduction = () => pool.query('UPDATE payroll_components SET is_active = false WHERE id = $1', [comp.loan]);

describe('no active LOAN deduction', () => {
  it.each([
    ['only a LOAN-coded earning', true],
    ['no LOAN component at all', false],
  ])('%s: nothing is taken, the loan is untouched, the line says so and approval is refused', async (_what, earning) => {
    const plain = await line(state.nov);
    await withoutLoanDeduction();
    if (earning) await addComponent(state.coA, 'Loan earning', 'LOAN', 'earning', true);
    const loan = await addLoan(1000);
    await recalculate(state.nov);

    const l = await line(state.nov);
    expect({ gross: l.gross, net: l.net, paye: l.paye }).toEqual({ gross: plain.gross, net: plain.net, paye: plain.paye });
    expect(codes(l)).toContain('LOAN_DEDUCTION_MISSING');
    expect(await loanState(loan)).toEqual({ balance: 1000, paidFlags: [false], payments: 0 });

    const { blocker, planHash } = (await preview(state.nov)).body.data!;
    expect(blocker).toMatchObject({ code: 'loan_deduction_missing' });
    expect(blocker.detail).toContain('W301-1');
    expect(blocker.detail).toContain('R-LOAN');
    const res = await doApprove(state.nov, planHash);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(await header(state.nov)).toMatchObject({ status: 'calculated', journal_entry_id: null });
  });

  it('adding the deduction and recalculating takes the instalment once', async () => {
    await withoutLoanDeduction();
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    await pool.query('UPDATE payroll_components SET is_active = true WHERE id = $1', [comp.loan]);
    await recalculate(state.nov);
    expect(codes(await line(state.nov))).not.toContain('LOAN_DEDUCTION_MISSING');
    expect(await loanState(loan)).toEqual({ balance: 0, paidFlags: [true], payments: 1 });
    expect((await preview(state.nov)).body.data!.blocker).toBeNull();
  });

  it('a LOAN deduction coded with spaces round it is the calculator\'s LOAN, and takes the instalment', async () => {
    await withoutLoanDeduction();
    await addComponent(state.coA, 'Spaced loan', ' LOAN\t', 'deduction', false);
    const plain = await line(state.nov);
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    expect((await line(state.nov)).net).toBeCloseTo(plain.net - 1000, 2);
    expect(await loanState(loan)).toEqual({ balance: 0, paidFlags: [true], payments: 1 });
  });
});

describe('a proper LOAN deduction', () => {
  it('takes the instalment as before: the payslip, the balance, the schedule and the payment agree', async () => {
    const plain = await line(state.nov);
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(l.net).toBeCloseTo(plain.net - 1000, 2);
    expect(l.paye).toBe(plain.paye);
    expect(codes(l)).toEqual([]);
    expect(await loanState(loan)).toEqual({ balance: 0, paidFlags: [true], payments: 1 });
  });
});

describe('MCP calculate_pay_run says which instalments it did not take', () => {
  const tool = (dry: boolean) => calculatePayRunTool.handler(
    { run_id: state.nov, idempotency_key: crypto.randomUUID(), ...(dry ? { dry_run: true } : {}) },
    { companyId: state.coA, userId: fx.admin } as never,
  );
  const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

  it('the dry run names the loan it would withhold, and writes nothing', async () => {
    await withoutLoanDeduction();
    const loan = await addLoan(1000);
    const out = body(await tool(true) as never);
    expect(out.withheld_loans).toEqual([{ employee_number: 'W301-1', loan_number: 'R-LOAN', instalment: 1000, missing: ['LOAN deduction'] }]);
    expect(await loanState(loan)).toEqual({ balance: 1000, paidFlags: [false], payments: 0 });
  });

  it('the dry run counts the row this run itself took, since recosting would undo it first', async () => {
    await addLoan(1000);
    await recalculate(state.nov); // taken with the deduction: the schedule row is this run's
    await withoutLoanDeduction();
    expect(body(await tool(true) as never).withheld_loans)
      .toEqual([{ employee_number: 'W301-1', loan_number: 'R-LOAN', instalment: 1000, missing: ['LOAN deduction'] }]);
  });

  it('the live call reports what it withheld', async () => {
    await withoutLoanDeduction();
    await addLoan(1000);
    expect(body(await tool(false) as never).withheld_loans)
      .toEqual([{ employee_number: 'W301-1', loan_number: 'R-LOAN', instalment: 1000, missing: ['LOAN deduction'] }]);
  });

  it('a properly set-up company withholds nothing, live or dry', async () => {
    await addLoan(1000);
    expect(body(await tool(true) as never).withheld_loans).toEqual([]);
    expect(body(await tool(false) as never).withheld_loans).toEqual([]);
  });

  const withheldDry = async () => body(await tool(true) as never).withheld_loans;

  it('the dry run, as the live call: a loan this run paid that is cancelled since is not offered again', async () => {
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    await pool.query(`UPDATE payroll_loans SET status = 'cancelled' WHERE id = $1`, [loan]);
    await withoutLoanDeduction();
    expect(await withheldDry()).toEqual([]);
    await recalculate(state.nov);
    expect(codes(await line(state.nov))).not.toContain('LOAN_DEDUCTION_MISSING');
  });

  it('the dry run counts a payment stranded by a deleted run (run_id NULL), which recosting reclaims', async () => {
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    await pool.query('UPDATE payroll_loan_payments SET run_id = NULL WHERE loan_id = $1', [loan]);
    await withoutLoanDeduction();
    expect(await withheldDry()).toHaveLength(1);
  });

  it('the dry run counts a pre-622 payment, which recorded no schedule row', async () => {
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    await pool.query('UPDATE payroll_loan_payments SET schedule_row_id = NULL WHERE loan_id = $1', [loan]);
    await withoutLoanDeduction();
    expect(await withheldDry()).toHaveLength(1);
  });

  it('a locked run: the dry run promises no recost and reports nothing withheld', async () => {
    await withoutLoanDeduction();
    await addLoan(1000);
    await pool.query(`UPDATE payroll_run_headers SET status = 'approved' WHERE id = $1`, [state.nov]);
    const out = body(await tool(true) as never);
    expect(out.effects).toEqual([]);
    expect(JSON.stringify(out.skipped)).toContain('locked');
    expect(out.withheld_loans).toEqual([]);
  });

  it('list_payroll_components reports a LOAN component flagged taxable as non-taxable for payroll', async () => {
    await pool.query('UPDATE payroll_components SET is_taxable = true WHERE id = $1', [comp.loan]);
    const listed = body(await listPayrollComponentsTool.handler({}, { companyId: state.coA, userId: fx.admin } as never) as never)
      .components as Array<{ id: string; is_taxable: boolean; note?: string }>;
    expect(listed.find((c) => c.id === comp.loan)).toMatchObject({ is_taxable: false });
    expect(listed.find((c) => c.id === comp.loan)!.note).toContain('not a tax deduction');
  });
});

