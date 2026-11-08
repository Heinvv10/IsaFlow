/**
 * Wave 5 FS: payslip finality is a stamp set at approval and cleared on reopen (migration 968),
 * not the R-035 guard re-judged on every read. Real routes (withAuth, app_user, RLS) against the
 * disposable fixture. Covers: approve stamps, reopen clears, calculate never stamps, the backfill
 * stamps every approved/paid run (and no other), and the wave-4 "known limit" inverted: a run whose
 * approval record is gone (as with enforcement off at approval) stays FINAL in the slip, the history
 * and the year to date.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig } from './brkr.helpers';
import { outsideRls } from './k1-employee-bank-details.helpers';
import { isPayRunFinal } from '../../src/modules/accounting/services/payroll/payslipFinal';
import { listEmployeePayslips } from '../../src/modules/accounting/services/payroll/payslipHistory';
import { getPayslips } from '../../src/modules/accounting/services/payroll/payslipModel';

let r: Awaited<ReturnType<typeof rig>>;
let emp = '';
const MIGRATION = readFileSync('scripts/migrations/sql/968_pay_run_payslips_final.sql', 'utf8');

const stamp = async (id: string) => (await r.pool.query(
  'SELECT status, payslips_final_at, payslips_final_by FROM payroll_run_headers WHERE id = $1', [id])).rows[0]!;
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

describe('approve stamps, reopen clears, calculate never stamps', () => {
  it('a calculated run has no stamp and is DRAFT', async () => {
    const id = await r.calculatedRun(1);
    expect(await stamp(id)).toMatchObject({ status: 'calculated', payslips_final_at: null, payslips_final_by: null });
    expect(await final(id)).toBe(false);
  });

  it('approving stamps the time and the approver, and the slip is final', async () => {
    const id = await approved(2);
    const s = await stamp(id);
    expect(s).toMatchObject({ status: 'approved', payslips_final_by: r.admin });
    expect(s.payslips_final_at).toBeInstanceOf(Date);
    expect(await final(id)).toBe(true);
    expect((await outsideRls(r.pool, r.company, () => getPayslips(r.company, id))).final).toBe(true);
  });

  it('reopening clears both columns and the slip is DRAFT again; recalculating and re-approving stamps afresh', async () => {
    const id = await approved(3);
    const first = (await stamp(id)).payslips_final_at as Date;
    expect((await r.api.reopen(id)).statusCode).toBe(200);
    expect(await stamp(id)).toMatchObject({ status: 'calculated', payslips_final_at: null, payslips_final_by: null });
    expect(await final(id)).toBe(false);
    expect((await r.api.calculate(id)).statusCode).toBe(200);
    expect((await stamp(id)).payslips_final_at).toBeNull();
    expect((await r.api.approve(id)).statusCode).toBe(200);
    expect(((await stamp(id)).payslips_final_at as Date).getTime()).toBeGreaterThan(first.getTime());
  });

  it('a stamp on a run that is not approved or paid does not make it final', async () => {
    const id = await r.calculatedRun(4);
    await r.pool.query('UPDATE payroll_run_headers SET payslips_final_at = now() WHERE id = $1', [id]);
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
    const next = await r.calculatedRun(6);
    const ytd = (await outsideRls(r.pool, r.company, () => getPayslips(r.company, next, [emp]))).payslips[0]!.yearToDate;
    const stored = await r.pool.query(
      `SELECT sum(l.gross_pay)::float8 AS gross FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
        WHERE h.company_id = $1 AND l.employee_id = $2 AND h.period_month IN (2, 3, 5, 6) AND h.period_year = 2026
          AND (h.payslips_final_at IS NOT NULL OR h.id = $3)`, [r.company, emp, next]);
    expect(ytd.grossPay).toBe(stored.rows[0]!.gross);
  });
});

describe('the migration backfill', () => {
  const ids: Record<string, string> = {};
  async function header(year: number, status: string, cols: Record<string, string | null> = {}): Promise<string> {
    const keys = Object.keys(cols);
    return (await r.pool.query(
      `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status${keys.map((k) => `, ${k}`).join('')})
       VALUES ($1, 7, $2, $3${keys.map((_, i) => `, $${i + 4}`).join('')}) RETURNING id`,
      [r.company, year, status, ...keys.map((k) => cols[k])])).rows[0]!.id;
  }
  const runMigration = () => r.pool.query(`BEGIN; ${MIGRATION}; COMMIT;`);

  it('stamps every approved or paid run however it cleared, and nothing else; a second run changes nothing', async () => {
    ids.approvedAt = await header(2031, 'approved', { approved_at: '2031-07-25T08:00:00Z' });
    ids.grandfathered = await header(2032, 'approved', { approval_grandfathered_at: '2031-01-02T00:00:00Z' });
    ids.neither = await header(2033, 'paid');
    ids.uncleared = await header(2034, 'approved', { approved_plan_hash: 'never-reviewed' });
    ids.calculated = await header(2035, 'calculated');
    ids.draft = await header(2036, 'draft');
    ids.cancelled = await header(2037, 'cancelled');
    await runMigration();
    const row = async (k: string) => stamp(ids[k]!);
    expect((await row('approvedAt')).payslips_final_at.toISOString()).toBe('2031-07-25T08:00:00.000Z');
    expect((await row('grandfathered')).payslips_final_at.toISOString()).toBe('2031-01-02T00:00:00.000Z');
    for (const k of ['approvedAt', 'grandfathered', 'neither', 'uncleared']) {
      expect((await row(k)).payslips_final_by, k).toBe('system:migration');
      expect((await row(k)).payslips_final_at, k).not.toBeNull();
    }
    for (const k of ['calculated', 'draft', 'cancelled']) {
      expect(await row(k), k).toMatchObject({ payslips_final_at: null, payslips_final_by: null });
    }
    const before = (await row('neither')).payslips_final_at;
    await runMigration();
    expect((await row('neither')).payslips_final_at).toEqual(before);
  });
});
