/**
 * Wave 5 FS: payslip finality is the header's own approval time (approved/paid with
 * COALESCE(approved_at, approval_grandfathered_at)), not the R-035 guard re-judged on every read. Real routes (withAuth, app_user, RLS) against the
 * disposable fixture. Covers: approve makes it final, reopen makes it DRAFT, calculate never does, an approved
 * row with neither column is DRAFT, a grandfathered one is final, and the wave-4 "known limit" inverted: a run whose
 * approval record is gone (as with enforcement off at approval) stays FINAL in the slip, the history
 * and the year to date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';
import { outsideRls } from './k1-employee-bank-details.helpers';
import { isPayRunFinal } from '../../src/modules/accounting/services/payroll/payslipFinal';
import { listEmployeePayslips } from '../../src/modules/accounting/services/payroll/payslipHistory';
import { getPayslips } from '../../src/modules/accounting/services/payroll/payslipModel';

let r: Awaited<ReturnType<typeof rig>>;
let emp = '';

const stamp = async (id: string) => (await r.pool.query(
  'SELECT status, approved_at, approval_grandfathered_at FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
const final = (id: string) => outsideRls(r.pool, r.company, () => isPayRunFinal(r.company, id));
async function approved(month: number): Promise<string> {
  const id = await r.calculatedRun(month);
  const res = await r.api.approve(id);
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return id;
}

beforeAll(async () => {
  r = await rig('fs-payslip-final');
  await r.setup();
  emp = (await r.employee(30000)).employee;
}, 120000);
afterAll(async () => { await r.teardown(); });

describe('approve is final, reopen is DRAFT, calculate never final', () => {
  it('a calculated run is DRAFT', async () => {
    const id = await r.calculatedRun(1);
    expect(await stamp(id)).toMatchObject({ status: 'calculated', approved_at: null });
    expect(await final(id)).toBe(false);
  });

  it('approving sets approved_at in the same UPDATE as the status, and the slip is final', async () => {
    const id = await approved(2);
    const s = await stamp(id);
    expect(s.status).toBe('approved');
    expect(s.approved_at).toBeInstanceOf(Date);
    expect(await final(id)).toBe(true);
    expect((await outsideRls(r.pool, r.company, () => getPayslips(r.company, id))).final).toBe(true);
  });

  it('reopening clears approved_at and approval_grandfathered_at and the slip is DRAFT again; recalculating and re-approving is final again', async () => {
    const id = await approved(3);
    const first = (await stamp(id)).approved_at as Date;
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect(await stamp(id)).toMatchObject({ status: 'calculated', approved_at: null, approval_grandfathered_at: null });
    expect(await final(id)).toBe(false);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect((await stamp(id)).approved_at).toBeNull();
    expect((await r.api.approve(id)).statusCode).toBe(200);
    expect(((await stamp(id)).approved_at as Date).getTime()).toBeGreaterThan(first.getTime());
  });

  it('an approval time on a run that is not approved or paid does not make it final', async () => {
    const id = await r.calculatedRun(4);
    await r.pool.query('UPDATE payroll_run_headers SET approved_at = now() WHERE id = $1', [id]);
    expect(await final(id)).toBe(false);
  });
});

describe('known limit inverted: finality survives the approval record', () => {
  it('a run approved, whose R-035 record is then gone (as when enforcement was off), stays FINAL in the slip, the history and the year to date', async () => {
    const id = await approved(5);
    await r.pool.query('DELETE FROM approval_requests WHERE company_id = $1', [r.company]);
    expect(await final(id)).toBe(true);
    expect((await outsideRls(r.pool, r.company, () => getPayslips(r.company, id))).final).toBe(true);
    const history = await outsideRls(r.pool, r.company, () => listEmployeePayslips(r.company, emp));
    expect(history!.find((e) => e.periodMonth === 5)!.final).toBe(true);
    // PAYE tax year 2027 starts March 2026: month 4 (calculated, no approval time) must be left out of the year to date.
    const next = await r.calculatedRun(6);
    const ytd = (await outsideRls(r.pool, r.company, () => getPayslips(r.company, next, [emp]))).payslips[0]!.yearToDate;
    const stored = await r.pool.query(
      `SELECT sum(l.gross_pay)::float8 AS gross FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
        WHERE h.company_id = $1 AND l.employee_id = $2 AND h.period_month IN (3, 4, 5, 6) AND h.period_year = 2026
          AND ((h.status IN ('approved', 'paid') AND COALESCE(h.approved_at, h.approval_grandfathered_at) IS NOT NULL) OR h.id = $3)`, [r.company, emp, next]);
    expect(ytd.grossPay).toBe(stored.rows[0]!.gross);
  });
});

describe('approved rows by how they were approved', () => {
  async function header(year: number, status: string, cols: Record<string, string | null> = {}): Promise<string> {
    const keys = Object.keys(cols);
    return (await r.pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status${keys.map((k) => `, ${k}`).join('')})
       VALUES ($1, 7, $2, $3${keys.map((_, i) => `, $${i + 4}`).join('')}) RETURNING id`,
      [r.company, year, status, ...keys.map((k) => cols[k])])).rows[0]!.id;
  }

  it('approved_at or grandfathered (approved or paid) is final; neither column, or another status, is DRAFT', async () => {
    const approvedAt = await header(2031, 'approved', { approved_at: '2031-07-25T08:00:00Z' });
    const grandfathered = await header(2032, 'approved', { approval_grandfathered_at: '2031-01-02T00:00:00Z' });
    const paid = await header(2033, 'paid', { approved_at: '2033-07-25T08:00:00Z' });
    const neither = await header(2034, 'approved');
    const draft = await header(2036, 'draft');
    const cancelled = await header(2037, 'cancelled', { approved_at: '2037-07-25T08:00:00Z' });
    expect([await final(approvedAt), await final(grandfathered), await final(paid)]).toEqual([true, true, true]);
    expect([await final(neither), await final(draft), await final(cancelled)]).toEqual([false, false, false]);
  });
});
