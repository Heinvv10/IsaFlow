/**
 * Wave 6 OC, UI review #1620 H: Cancel run for an off-cycle run that is not final, through the real route, two tenants.
 *  - a calculated bonus run is cancelled: its lines are deleted, its totals zeroed, its status 'cancelled';
 *  - every reader ignores it: EMP201, the PAYE year to date, the 13-week forecast, the owner cash position, the
 *    journals and payslip finality read exactly what they read before the run existed; the regular run's ETI line is
 *    untouched (an off-cycle run never closes a month's ETI);
 *  - its employees are released: a new off-cycle run for them is created, even on the cancelled run's pay date;
 *  - refused (409, nothing written): an approved off-cycle run, a regular run; 403 for a manager; 404 for tenant B.
 * The clock is SAST 2026-11-17 (Date only, advancing), so the pay-date rules hold whatever day the suite runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import cancel from '../../pages/api/payroll/runs/[id]/cancel';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { loadPayeYearToDate } from '@/modules/accounting/services/payroll/payrollYearToDate';
import { readPayroll } from '@/modules/accounting/services/cashForecast13/readPayroll';
import { getOwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';
import { isPayRunFinal } from '@/modules/accounting/services/payroll/payslipFinal';
import { getPayrollRun } from '@/modules/accounting/services/payroll/payrollRunHeaders';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

type Rig = Awaited<ReturnType<typeof rig>>;
let a: Rig;
let b: Rig;
let bonusComponent = '';
let regular = '';
const p: Record<string, string> = {};

const create = (body: Record<string, unknown>) =>
  a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month: 11, year: 2026, ...body } });
const bonus = (runDate: string) => create({ reason: 'bonus', runDate, employees: [
  { employeeId: p.mid, componentId: bonusComponent, amount: 5_000 }, { employeeId: p.young, componentId: bonusComponent, amount: 1_000 },
] });
const cancelRun = (r: Rig, id: string, o: { user?: string } = {}) => r.call(cancel as Route, 'POST', `/api/payroll/runs/${id}/cancel`, id, o);
const n = async (q: string, params: unknown[]) => Number((await a.pool.query(q, params)).rows[0].n);
/** What every reader says about November 2026 (and the year to date December would read). */
async function readers() {
  const emp201 = await generateEMP201(a.company, '2026-11-01', '2026-11-30');
  const ytd = (await loadPayeYearToDate(a.company, crypto.randomUUID(), { year: 2026, month: 12 }, [p.mid!])).get(p.mid!);
  const cash13 = await readPayroll(a.company);
  const owner = await getOwnerCashPosition(a.company, 1_000_000, new Date('2026-11-20T10:00:00Z'));
  return {
    emp201: { paye: emp201.totalPAYE, uif: emp201.totalUIF, sdl: emp201.totalSDL, eti: emp201.totalETI },
    ytd: { periods: ytd?.periods, periodic: ytd?.periodicTaxable, annual: ytd?.annualPayments },
    cash13: { runs: cash13.runs.map((r) => r.id), offCycle: (cash13.offCycle ?? []).map((r) => r.id) },
    owner: owner.payroll,
    journals: await n('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = $1', [a.company]),
    regularYoungEti: Number((await a.pool.query('SELECT eti FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [regular, p.young])).rows[0].eti),
  };
}

beforeAll(async () => {
  a = await rig('w6-oc-cancel-a');
  b = await rig('w6-oc-cancel-b');
  await a.setup();
  await b.setup();
  p.mid = (await a.employee(15_000)).employee;
  p.young = (await a.employee(5_300)).employee;
  await a.pool.query(`UPDATE payroll_employees SET date_of_birth = '2004-06-01', id_number = '0406015009086', hours_per_week = 40,
    start_date = '2026-01-01', medical_aid_main_member = false WHERE id = $1`, [p.young]);
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  for (const r of [a, b]) {
    await r.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.pool.query('DELETE FROM audit_log WHERE company_id = $1', [r.company]).catch(() => undefined);
    await r.teardown();
  }
  vi.useRealTimers();
}, 120_000);

describe('Cancel run', () => {
  let cancelled = '';
  it('cancels a calculated bonus run; every reader then reads what it read before the run existed', async () => {
    const before = await readers();
    const made = await bonus('2026-11-24');
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    cancelled = String(made.body.data!.id);
    expect((await a.api.calculate(cancelled)).statusCode).toBe(200);
    expect(await n('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [cancelled])).toBe(2);

    expect((await cancelRun(b, cancelled)).statusCode).toBe(404); // tenant B cannot reach it
    const manager = await a.addUser('manager');
    expect((await cancelRun(a, cancelled, { user: manager })).statusCode).toBe(403);
    const done = await cancelRun(a, cancelled);
    expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'cancelled', totalGross: 0, totalNet: 0 });
    expect(await n('SELECT count(*)::int AS n FROM payroll_run_lines WHERE run_id = $1', [cancelled])).toBe(0);
    expect(await isPayRunFinal(a.company, cancelled)).toBe(false);
    expect(await readers()).toEqual(before);
  });

  it('releases its employees: a new off-cycle run for them is created, on the same pay date', async () => {
    const again = await bonus('2026-11-24');
    expect(again.statusCode, JSON.stringify(again.body)).toBe(201);
    const id = String(again.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    expect((await a.api.approve(id)).statusCode).toBe(200);
    // Approved: no longer cancellable (409, nothing changed).
    const refused = await cancelRun(a, id);
    expect(refused.statusCode).toBe(409);
    expect(a.msg(refused)).toMatch(/is approved: only a draft or calculated off-cycle run can be cancelled/);
    expect((await a.header(id)).status).toBe('approved');
  });

  it('withdraws the run\'s pending approval request in the same transaction, with the pay run\'s audit row', async () => {
    await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-20', termination_reason = 'resignation',
      termination_notice_period_days = 30, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [p.mid]);
    const made = await create({ reason: 'termination', runDate: '2026-11-26', employees: [{ employeeId: p.mid }] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    const raised = await a.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined, {
      body: { action: 'request', documentType: 'pay_run', documentId: id },
    });
    expect(raised.statusCode, JSON.stringify(raised.body)).toBe(200);
    const requestId = String((raised.body.data as { id: string }).id);
    const done = await cancelRun(a, id);
    expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
    const req = (await a.pool.query('SELECT status, decided_by::text AS by, decision_notes FROM approval_requests WHERE id = $1', [requestId])).rows[0];
    expect(req).toMatchObject({ status: 'rejected', by: a.admin, decision_notes: 'Withdrawn: the off-cycle run was cancelled.' });
    expect(await n(`SELECT count(*)::int AS n FROM approval_requests WHERE company_id = $1 AND status = 'pending'`, [a.company])).toBe(0);
    expect(await n(`SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_run' AND entity_id = $2
      AND action = 'reject' AND changes->'metadata'->>'requestId' = $3`, [a.company, id, requestId])).toBe(1);
  });

  it('a pending request decided while cancel runs: cancel waits for it and cancels (200), never a 500 (review L3 of 819c2861c0)', async () => {
    const made = await create({ reason: 'termination', runDate: '2026-11-26', employees: [{ employeeId: p.mid }] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    const raised = await a.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined, {
      body: { action: 'request', documentType: 'pay_run', documentId: id },
    });
    expect(raised.statusCode, JSON.stringify(raised.body)).toBe(200);
    const requestId = String((raised.body.data as { id: string }).id);
    // Another session holds the request (as a decision does) and rejects it while cancel is under way.
    const other = await a.pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM approval_requests WHERE id = $1 FOR UPDATE', [requestId]);
      const cancelling = cancelRun(a, id);
      await new Promise((r) => setTimeout(r, 1_000));
      await other.query(`UPDATE approval_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_notes = 'decided elsewhere'
        WHERE id = $1`, [requestId, a.approver]);
      await other.query('COMMIT');
      const done = await cancelling;
      expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
    } finally {
      other.release();
    }
    expect((await a.pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [id])).rows[0].status).toBe('cancelled');
    expect((await a.pool.query('SELECT decision_notes FROM approval_requests WHERE id = $1', [requestId])).rows[0].decision_notes).toBe('decided elsewhere');
  });

  it('a run whose approval was already cleared (request approved, run not final): cancelled, the cleared request stays history and can approve nothing', async () => {
    await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-21', termination_reason = 'resignation',
      termination_notice_period_days = 30, termination_served_notice_days = 0, termination_include_leave_payout = false WHERE id = $1`, [p.young]);
    const made = await create({ reason: 'termination', runDate: '2026-11-27', employees: [{ employeeId: p.young }] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = String(made.body.data!.id);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    await a.authorise(id);
    const cleared = (await a.pool.query(`SELECT id FROM approval_requests WHERE document_id = $1 AND status = 'approved'`, [id])).rows;
    expect(cleared).toHaveLength(1);
    const done = await cancelRun(a, id);
    expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
    const run = await getPayrollRun(id, a.company);
    expect(run).toMatchObject({ status: 'cancelled' });
    expect(run?.cancelledAt).toBeTruthy();
    expect((await a.pool.query('SELECT cancelled_by FROM payroll_run_headers WHERE id = $1', [id])).rows[0].cancelled_by).toBe(a.admin);
    expect((await a.pool.query('SELECT status FROM approval_requests WHERE id = $1', [cleared[0].id])).rows[0].status).toBe('approved');
    // Inert: approval refuses a cancelled run, so the cleared request can never post it.
    const planHash = (await a.api.preview(id)).body.data?.planHash;
    expect((await a.api.approveWith(id, planHash, { user: a.admin })).statusCode).not.toBe(200);
    expect((await a.header(id)).status).toBe('cancelled');
  });

  it('a regular run is never cancelled here: 409, nothing changed', async () => {
    const refused = await cancelRun(a, regular);
    expect(refused.statusCode).toBe(409);
    expect(a.msg(refused)).toMatch(/Only an off-cycle run can be cancelled/);
    expect((await a.header(regular)).status).toBe('approved');
  });
});
