/**
 * Wave 6 PS3: a final payslip prints the employee's and the employer's details as they were at approval, not as
 * they are at download. Real routes (withAuth, app_user, RLS) against the disposable fixture.
 *
 *  - approve -> edit the profile, the bank account and the company -> the final slip (model and PDF) keeps the old details;
 *  - the snapshot is not in the approval plan hash (no re-approval of approved runs, the RF lesson);
 *  - reopen clears it; recalculate and re-approve freezes the new details;
 *  - F8: a reopen and re-approve that skips the clear (an older colour) leaves a snapshot of an earlier approval,
 *    which is never used: the slip reads live details and says "as at download";
 *  - a final run from before PS3 (no snapshot) reads live and says "as at download";
 *  - tenancy: the freeze writes only the named company's run;
 *  - review B1: the year to date is frozen too: reopening an earlier month does not move a later final slip's;
 *  - review B3: re-approving an approved, unposted run (to post it) neither moves approved_at nor freezes details
 *    edited since: a pre-PS3 one stays live, "as at download";
 *  - a malformed snapshot approvedAt reads as not frozen, never a 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import payslips from '../../pages/api/payroll/runs/[id]/payslips';
import { rig } from './brkr.helpers';
import { callRoute } from './r035-approval.helpers';
import { outsideRls } from './k1-employee-bank-details.helpers';
import { getPayslips } from '../../src/modules/accounting/services/payroll/payslipModel';
import { freezePayslipDetails } from '../../src/modules/accounting/services/payroll/payslipSnapshot';

let r: Awaited<ReturnType<typeof rig>>;
let b: Awaited<ReturnType<typeof rig>>;
let emp = '';

async function pdfText(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: pdf }).getText()).text.replace(/\s+/g, ' ');
}

const model = (company: string, runId: string) => outsideRls(r.pool, company, () => getPayslips(company, runId, [emp]));
const snapshots = async (runId: string) => (await r.pool.query(
  'SELECT payslip_snapshot FROM payroll_run_lines WHERE run_id = $1', [runId])).rows.map((x) => x.payslip_snapshot as unknown);

async function approved(month: number): Promise<string> {
  const id = await r.calculatedRun(month);
  const res = await r.api.approve(id);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return id;
}

/** The profile, the bank account and the company as they are before any edit. */
async function resetDetails(): Promise<void> {
  await r.pool.query(
    `UPDATE payroll_employees SET first_name = 'Thandi', last_name = 'Before', tax_number = '0123456789', occupation = 'Clerk'
      WHERE id = $1`, [emp]);
  await r.pool.query('DELETE FROM payroll_bank_details WHERE employee_id = $1', [emp]);
  await r.pool.query(
    `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, branch_code)
     VALUES ($1, $2, 'FNB', '62000111111', '250655')`, [r.company, emp]);
  await r.pool.query(
    "UPDATE companies SET name = 'PS3 Before (Pty) Ltd', address_line1 = '1 Old Road', city = 'Pretoria' WHERE id = $1", [r.company]);
}

async function editDetails(): Promise<void> {
  await r.pool.query(
    `UPDATE payroll_employees SET first_name = 'Thandiwe', last_name = 'After', tax_number = '9876543210', occupation = 'Manager'
      WHERE id = $1`, [emp]);
  await r.pool.query('UPDATE payroll_bank_details SET is_active = false WHERE employee_id = $1', [emp]);
  await r.pool.query(
    `INSERT INTO payroll_bank_details (company_id, employee_id, bank_name, account_number, branch_code)
     VALUES ($1, $2, 'Capitec', '1357922222', '470010')`, [r.company, emp]);
  await r.pool.query(
    "UPDATE companies SET name = 'PS3 After (Pty) Ltd', address_line1 = '9 New Street', city = 'Durban' WHERE id = $1", [r.company]);
}

const BEFORE = {
  employeeName: 'Thandi Before', taxNumber: '0123456789', occupation: 'Clerk', bankName: 'FNB', bankLastFour: '1111',
};
const AFTER = {
  employeeName: 'Thandiwe After', taxNumber: '9876543210', occupation: 'Manager', bankName: 'Capitec', bankLastFour: '2222',
};

beforeAll(async () => {
  r = await rig('ps3-payslip-freeze');
  await r.setup();
  emp = (await r.employee(30000)).employee;
  b = await rig('ps3-payslip-freeze-b');
  await b.setup();
  await b.employee(25000);
}, 120000);

afterAll(async () => {
  await r.pool.query('DELETE FROM audit_log WHERE company_id = ANY($1)', [[r.company, b.company]]);
  await r.pool.query('DELETE FROM payroll_bank_details WHERE company_id = $1', [r.company]);
  await b.teardown();
  await r.teardown();
});

describe('approve freezes the details; edits after approval do not reach the final slip', () => {
  it('the model and the PDF keep the name, tax number, occupation, bank and employer of the approval', async () => {
    await resetDetails();
    const id = await approved(3);
    await editDetails();

    const run = await model(r.company, id);
    expect(run.final).toBe(true);
    expect(run.detailsAsAt).toBe('approval');
    expect(run.employer).toEqual({ name: 'PS3 Before (Pty) Ltd', address: '1 Old Road, Pretoria' });
    expect(run.payslips[0]).toMatchObject(BEFORE);

    const res = await callRoute(payslips as never, r.tokens[r.admin]!, r.company, 'GET', undefined,
      `/api/payroll/runs/${id}/payslips`, { id, employeeId: emp, disposition: 'inline' });
    expect(res.state.statusCode).toBe(200);
    const text = await pdfText(res.state.body as Buffer);
    expect(text).toContain('Thandi Before');
    expect(text).toContain('PS3 Before (Pty) Ltd');
    expect(text).not.toContain('Thandiwe');
    expect(text).not.toContain('as at download');
    expect(text).toContain('0123456789');
    expect(text).not.toContain('9876543210');
    expect(text).toContain('FNB');
    expect(text).not.toContain('Capitec');

    // The snapshot holds the last four digits only, never the account number.
    expect(JSON.stringify(await snapshots(id))).not.toContain('62000111111');
  });

  it('the snapshot is not in the plan hash: the approved run hashes the same with and without it', async () => {
    await resetDetails();
    const id = await r.calculatedRun(4);
    const before = (await r.api.preview(id)).body.data?.planHash as string;
    expect((await r.api.approveWith(id, before)).statusCode).toBe(200);
    expect((await snapshots(id)).every((s) => s != null)).toBe(true);
    const withSnapshot = (await r.api.preview(id)).body.data?.planHash as string;
    await r.pool.query('UPDATE payroll_run_lines SET payslip_snapshot = NULL WHERE run_id = $1', [id]);
    const without = (await r.api.preview(id)).body.data?.planHash as string;
    expect(withSnapshot).toBe(without);
    const stored = (await r.pool.query('SELECT approved_plan_hash FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
    expect(stored.approved_plan_hash).toBe(before);
  });
});

describe('reopen clears; re-approval freezes again', () => {
  it('reopen leaves no snapshot; the draft reads live; re-approve prints the new details', async () => {
    await resetDetails();
    const id = await approved(5);
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect(await snapshots(id)).toEqual([null]);
    await editDetails();
    const draft = await model(r.company, id);
    expect(draft.final).toBe(false);
    expect(draft.payslips[0]).toMatchObject(AFTER);

    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect((await r.api.approve(id)).statusCode).toBe(200);
    await resetDetails(); // edits after the second approval do not reach the slip either
    const run = await model(r.company, id);
    expect(run.detailsAsAt).toBe('approval');
    expect(run.payslips[0]).toMatchObject(AFTER);
    expect(run.employer.name).toBe('PS3 After (Pty) Ltd');
  });
});

describe('F8: a snapshot of an earlier approval is never shown as final', () => {
  it('reopen and re-approve through a path that skips the clear: live details, "as at download"', async () => {
    await resetDetails();
    const id = await approved(6);
    // An older colour's reopen (no clear) and re-approval (no freeze): only the header moves.
    await r.pool.query(
      "UPDATE payroll_run_headers SET status = 'calculated', approved_at = NULL, approved_by = NULL WHERE id = $1", [id]);
    await editDetails();
    await r.pool.query(
      "UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1", [id]);
    expect((await snapshots(id)).every((s) => s != null)).toBe(true);

    const run = await model(r.company, id);
    expect(run.final).toBe(true);
    expect(run.detailsAsAt).toBe('download');
    expect(run.payslips[0]).toMatchObject(AFTER);
    expect(run.employer.name).toBe('PS3 After (Pty) Ltd');
  });

  it('a final run from before PS3 (no snapshot) reads live and says so, on the PDF too', async () => {
    await resetDetails();
    const id = await approved(7);
    await r.pool.query('UPDATE payroll_run_lines SET payslip_snapshot = NULL WHERE run_id = $1', [id]);
    await editDetails();
    const run = await model(r.company, id);
    expect(run.final).toBe(true);
    expect(run.detailsAsAt).toBe('download');
    expect(run.payslips[0]).toMatchObject(AFTER);

    const res = await callRoute(payslips as never, r.tokens[r.admin]!, r.company, 'GET', undefined,
      `/api/payroll/runs/${id}/payslips`, { id, employeeId: emp, disposition: 'inline' });
    expect(res.state.statusCode).toBe(200);
    expect(await pdfText(res.state.body as Buffer)).toContain('as at download');
  });
});

describe('tenancy', () => {
  it("freezing names one company's run: another company's run id freezes nothing", async () => {
    const theirs = await b.calculatedRun(8);
    await b.pool.query("UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() WHERE id = $1", [theirs]);
    // outsideRls rolls back: each freeze is judged by the lines it reports, inside its own transaction.
    expect(await outsideRls(r.pool, r.company, () => freezePayslipDetails(r.company, theirs))).toBe(0);
    expect(await outsideRls(b.pool, b.company, () => freezePayslipDetails(b.company, theirs))).toBe(1);
    expect((await b.pool.query('SELECT payslip_snapshot FROM payroll_run_lines WHERE run_id = $1', [theirs])).rows)
      .toEqual([{ payslip_snapshot: null }]);
  });
});

describe('review B1: the year to date as issued', () => {
  it("reopening an earlier month does not change a later final slip's year to date", async () => {
    await resetDetails();
    const sep = await approved(9);
    const oct = await approved(10);
    const before = (await model(r.company, oct)).payslips[0]!.yearToDate;
    expect((await r.api.reopen(sep)).statusCode).toBe(200);
    const after = await model(r.company, oct);
    expect(after.detailsAsAt).toBe('approval');
    expect(after.payslips[0]!.yearToDate).toEqual(before);
    // The live year to date has moved: the frozen one is what the slip printed at approval.
    await r.pool.query('UPDATE payroll_run_lines SET payslip_snapshot = NULL WHERE run_id = $1', [oct]);
    expect((await model(r.company, oct)).payslips[0]!.yearToDate.grossPay).toBeLessThan(before.grossPay);
  });
});

describe('review B3: re-approving an approved, unposted run', () => {
  it('keeps approved_at and freezes nothing: a pre-PS3 run edited since approval stays live, "as at download"', async () => {
    await resetDetails();
    const id = await r.calculatedRun(11);
    await r.pool.query(
      `UPDATE payroll_run_headers SET status = 'approved', approved_at = clock_timestamp() - interval '20 days',
              lines_confirmed_at = clock_timestamp() WHERE id = $1`, [id]);
    const first = (await r.pool.query('SELECT approved_at FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!.approved_at as Date;
    await editDetails();
    const res = await r.api.approve(id);
    expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
    const h = (await r.pool.query('SELECT approved_at, journal_entry_id FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
    expect(h.journal_entry_id).not.toBeNull();
    expect((h.approved_at as Date).getTime()).toBe(first.getTime());
    expect(await snapshots(id)).toEqual([null]);
    const run = await model(r.company, id);
    expect(run.final).toBe(true);
    expect(run.detailsAsAt).toBe('download');
    expect(run.payslips[0]).toMatchObject(AFTER);
  });
});

describe('a malformed snapshot', () => {
  it('an approvedAt that is not a timestamp reads as not frozen, never a cast error', async () => {
    await resetDetails();
    const id = await approved(12);
    await r.pool.query(
      `UPDATE payroll_run_lines SET payslip_snapshot = jsonb_set(payslip_snapshot, '{approvedAt}', '"not a time"') WHERE run_id = $1`, [id]);
    await editDetails();
    const run = await model(r.company, id);
    expect(run.detailsAsAt).toBe('download');
    expect(run.payslips[0]).toMatchObject(AFTER);
  });
});
