/**
 * A run calculated before DEDUCTIONS_EXCEED_PAY and LOAN_INSTALMENT_EXCEEDS_PAY existed carries
 * neither code, so the approval gate reads the line as it was stored: its figures and its own
 * component breakdown, never the catalogue as it reads today. Fixtures clear the codes from a fresh
 * calculation to stand for such a line. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import { findOverdrawnLines } from '../../src/modules/accounting/services/payroll/payrollRunLines';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, line, preview, addRow, recalculate, addLoan, addComponent } = fx;
const comp = state.comp;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

/** The line as a calculation before the codes would have stored it. */
const asBeforeTheCodes = () => pool.query(`UPDATE payroll_run_lines SET validation_results = '[]'::jsonb WHERE run_id = $1`, [state.nov]);
/** A breakdown amount carrying a float tail, as termination pay and loan repayments wrote them. */
const tailOn = (code: string, tail: number) => pool.query(
  `UPDATE payroll_run_lines SET component_breakdown = (
     SELECT jsonb_agg(CASE WHEN i->>'sarsSourceCode' = $3
       THEN jsonb_set(i, '{amount}', to_jsonb((i->>'amount')::numeric + $2::numeric)) ELSE i END ORDER BY o)
     FROM jsonb_array_elements(component_breakdown) WITH ORDINALITY AS e(i, o))
   WHERE run_id = $1`, [state.nov, tail, code]);
const judged = async () => {
  const { blocker, plan } = (await preview(state.nov)).body.data!;
  const loan = plan.advisories.find((a: { code: string }) => a.code === 'loan_instalment_exceeds_pay');
  return { blocker, loan };
};

describe('a run from before the codes', () => {
  it('a loan instalment above pay blocks approval, naming the employee', async () => {
    await addLoan(30000);
    await recalculate(state.nov);
    await asBeforeTheCodes();
    const { blocker } = await judged();
    expect(blocker).toMatchObject({ code: 'loan_instalment_exceeds_pay' });
    expect(blocker.detail).toContain('W301-1');
  });

  it('reads LOAN off the line as the calculator does: a code changed in the catalogue since does not move it', async () => {
    await addLoan(30000);
    await recalculate(state.nov);
    await asBeforeTheCodes();
    await pool.query(`UPDATE payroll_components SET sars_source_code = 'XLOAN' WHERE id = $1`, [comp.loan]);
    expect((await judged()).blocker).toMatchObject({ code: 'loan_instalment_exceeds_pay' });
  });

  it('a deduction coded "loan" in lower case is not an instalment to the calculator, so it blocks', async () => {
    const lower = await addComponent(state.coA, 'Lower loan', 'loan', 'deduction', false);
    await addRow(lower, 30000, '2026-01-01', null, true);
    await recalculate(state.nov);
    await asBeforeTheCodes();
    const { blocker, loan } = await judged();
    expect(blocker).toMatchObject({ code: 'deductions_exceed_pay' });
    expect(loan).toBeUndefined();
  });

  it('a deduction re-typed in the catalogue since is still the deduction the line took', async () => {
    await addRow(comp.union!, 30000, '2026-01-01', null, true);
    await recalculate(state.nov);
    await asBeforeTheCodes();
    await pool.query(`UPDATE payroll_components SET component_type = 'earning' WHERE id = $1`, [comp.union]);
    expect((await judged()).blocker).toMatchObject({ code: 'deductions_exceed_pay' });
  });

  it('a sub-cent tail on a line at exactly nil is no R0.01 blocker', async () => {
    const { net } = await line(state.nov);
    await addRow(comp.union!, net, '2026-01-01', null, true);
    await recalculate(state.nov);
    expect((await line(state.nov)).net).toBe(0);
    await asBeforeTheCodes();
    await tailOn('UNION', 0.004);
    expect(await judged()).toEqual({ blocker: null, loan: undefined });
  });

  it('nor, with a loan on it, an advisory of R0.00', async () => {
    await addLoan(1000);
    await recalculate(state.nov);
    const { net } = await line(state.nov);
    await addRow(comp.union!, net, '2026-01-01', null, true);
    await recalculate(state.nov);
    expect((await line(state.nov)).net).toBe(0);
    await asBeforeTheCodes();
    await tailOn('UNION', 0.004);
    expect(await judged()).toEqual({ blocker: null, loan: undefined });
  });

  it('a line with a code is judged by its raw net, not the stored figures', async () => {
    await addRow(comp.union!, 30000, '2026-01-01', null, true);
    await recalculate(state.nov);
    await tailOn('UNION', -29000); // the stored breakdown now reads as R1 000 of dues: the code still decides
    expect((await judged()).blocker).toMatchObject({ code: 'deductions_exceed_pay' });
  });

  const atNil = async () => {
    const { net } = await line(state.nov);
    await addRow(comp.union!, net, '2026-01-01', null, true);
    await recalculate(state.nov);
    expect((await line(state.nov)).net).toBe(0);
    await asBeforeTheCodes();
  };
  const breakdown = (json: string) => pool.query('UPDATE payroll_run_lines SET component_breakdown = $2::jsonb WHERE run_id = $1', [state.nov, json]);

  it('an empty breakdown beside a gross, on a line at nil, cannot be judged: the gate asks for a recalculation', async () => {
    await atNil();
    await breakdown('[]');
    const { blocker } = await judged();
    expect(blocker).toMatchObject({ code: 'run_lines_unreadable' });
    expect(blocker.detail).toContain('W301-1');
    expect(blocker.detail).toContain('Recalculate this run');
  });

  it('a breakdown that is not an array, on a line at nil, is unreadable here; the gate already fails closed on it earlier', async () => {
    await atNil();
    await breakdown('{"amount": 1}');
    expect(await findOverdrawnLines(state.coA, state.nov)).toMatchObject([{ employeeNumber: 'W301-1', unreadable: true }]);
    // judgeRunDirectives reads every breakdown as an array first: the preview is a 500, and so is approval.
    expect((await preview(state.nov)).statusCode).toBe(500);
  });

  it('an employee on no pay at all, nil gross and an empty breakdown, is readable and blocks nothing', async () => {
    await fx.addEmployee('W301-2');
    await recalculate(state.nov);
    await asBeforeTheCodes();
    expect(await judged()).toEqual({ blocker: null, loan: undefined });
  });

  it('an unreadable breakdown on a line that paid something blocks nothing', async () => {
    await asBeforeTheCodes();
    await breakdown('[]');
    expect((await judged()).blocker).toBeNull();
  });

  it('a line that paid something is never rebuilt, whatever its breakdown says', async () => {
    await addRow(comp.union!, 200, '2026-01-01', null, true);
    await recalculate(state.nov);
    await asBeforeTheCodes();
    await tailOn('UNION', 50000);
    expect(await judged()).toEqual({ blocker: null, loan: undefined });
  });
});
