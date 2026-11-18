/**
 * Wave 6 FQd: deleting a draft pay run through the real route (DELETE /api/payroll/runs/[id]; withAuth, app_user, RLS)
 * on two tenants (coordinator r3 ruling on #1575: cancel/delete for draft runs is FQd's). Claims:
 *  - a draft never calculated and never approved is deleted, audited once, and its period can be created again;
 *  - a calculated draft (it has lines), an approved run and a reopened one are refused 409 RUN_NOT_DELETABLE with the
 *    row, its lines and the audit unchanged;
 *  - a viewer is 403; another tenant's run is 404; neither changes a row.
 *
 * Disposable DB only (rig -> assertDisposable).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { audits, cleanup, type R } from './pe-payslip-email.helpers';
import runs from '../../pages/api/payroll/runs';
import runDetail from '../../pages/api/payroll/runs/[id]';
import { dayNumber, isoDow, isoOfDay } from '@/modules/accounting/services/payroll/payrollPayWeek';
import { todaySast } from '@/modules/accounting/services/payroll/payrollPayWeekSettings';

type Opts = { user?: string; company?: string };
let a: R;
let b: R;
const t = dayNumber(todaySast())!;
/** Monday three weeks out: clear of the other FQd suite's weeks. */
const MON = isoOfDay(t + 21 - (isoDow(t) - 1));

const create = (r: R, periodStart: string) =>
  r.call(runs as Route, 'POST', '/api/payroll/runs', undefined, { body: { frequency: 'weekly', periodStart } });
const del = (r: R, id: string, o: Opts = {}) => r.call(runDetail as Route, 'DELETE', `/api/payroll/runs/${id}`, id, o);
const header = async (r: R, id: string) => (await r.pool.query(
  'SELECT status, approved_at IS NOT NULL AS approved FROM payroll_run_headers WHERE id = $1', [id])).rows[0];
const lineCount = async (r: R, id: string) =>
  Number((await r.pool.query('SELECT count(*) FROM payroll_run_lines WHERE run_id = $1', [id])).rows[0]!.count);

beforeAll(async () => {
  a = await rig('fqd-del-a');
  b = await rig('fqd-del-b');
  await a.setup();
  await b.setup();
}, 120_000);
afterAll(async () => {
  for (const r of [a, b]) await cleanup(r);
});

describe('deleting a draft pay run', () => {
  it('deletes a draft never calculated, audited once; its period can be created again', async () => {
    const id = String((await create(a, MON)).body.data!.id);
    const before = await audits(a, 'payroll_run');
    const res = await del(a, id);
    expect([res.statusCode, res.body.data]).toEqual([200, { id, deleted: true }]);
    expect(await header(a, id)).toBeUndefined();
    expect(await audits(a, 'payroll_run')).toBe(before + 1);
    const again = await create(a, MON);
    expect(again.statusCode).toBe(201);
    await del(a, String(again.body.data!.id));
  });

  it('refuses a calculated draft, an approved run and a reopened one (409), changing nothing', async () => {
    const id = String((await create(a, MON)).body.data!.id);
    const { employee } = await a.employee(20000);
    await a.pool.query('INSERT INTO payroll_run_lines (run_id, employee_id) VALUES ($1, $2)', [id, employee]);
    const before = await audits(a, 'payroll_run');
    const calc = await del(a, id);
    expect([calc.statusCode, calc.body.error?.details?.reason]).toEqual([409, 'RUN_NOT_DELETABLE']);
    expect(calc.body.error?.message).toContain('calculated');
    expect([await header(a, id), await lineCount(a, id)]).toEqual([{ status: 'draft', approved: false }, 1]);
    await a.pool.query('DELETE FROM payroll_run_lines WHERE run_id = $1', [id]);
    for (const [status, approved] of [['approved', true], ['calculated', true]] as const) {
      await a.pool.query(`UPDATE payroll_run_headers SET status = $2, approved_at = ${approved ? 'now()' : 'NULL'} WHERE id = $1`, [id, status]);
      const res = await del(a, id);
      expect([res.statusCode, res.body.error?.details?.reason], status).toEqual([409, 'RUN_NOT_DELETABLE']);
      expect((await header(a, id))?.status, status).toBe(status);
    }
    expect(await audits(a, 'payroll_run')).toBe(before);
    await a.pool.query("UPDATE payroll_run_headers SET status = 'draft', approved_at = NULL WHERE id = $1", [id]);
    expect((await del(a, id)).statusCode).toBe(200);
  });

  it('a viewer is 403 and another tenant is 404, with the run left as it was', async () => {
    const id = String((await create(a, MON)).body.data!.id);
    const viewer = await a.addUser('viewer');
    expect((await del(a, id, { user: viewer })).statusCode).toBe(403);
    expect((await del(b, id)).statusCode).toBe(404);
    expect(await header(a, id)).toEqual({ status: 'draft', approved: false });
    expect((await del(a, id)).statusCode).toBe(200);
  });
});
