/**
 * Wave 6 RLS-L (migration 1010): the product's payroll paths still work with payroll_run_lines under FORCE row level
 * security, through the real routes (withAuth, app_user, the request's claims) on the disposable fixture, two
 * tenants. Every reader and writer of the table the census found on a request path is reached here at least once:
 *  - calculate writes the lines (replaceRunLines) and reads them back (recalc gate, run lines);
 *  - approve freezes the payslip details (freezePayslipDetails) and builds the journal from the lines (journal parts);
 *  - payslip PDF, line explanation, variance, cost-centre summary and the IRP5 summary read them;
 *  - reopen clears the snapshot (clearPayslipDetails); recalculate and re-approve write them again.
 * Tenant B's user, in B's company, gets nothing of A's run from the same routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import payslips from '../../pages/api/payroll/runs/[id]/payslips';
import explanation from '../../pages/api/payroll/runs/[id]/explanation';
import variance from '../../pages/api/payroll/runs/[id]/variance';
import costCentreSummary from '../../pages/api/payroll/runs/[id]/cost-centre-summary';
import irp5Summary from '../../pages/api/payroll/irp5/summary';
import { rig, type Res, type Route } from './brkr.helpers';
import { request, response } from './mfa-impersonation-postgres.helpers';

let a: Awaited<ReturnType<typeof rig>>;
let b: Awaited<ReturnType<typeof rig>>;
let empA = '';
let runA = '';

/** GET `route` as `who` in `company`, with the query given (the rig's caller sets only `id`). */
async function get(who: typeof a, company: string, route: unknown, url: string, query: Record<string, string>): Promise<Res & { type?: unknown }> {
  const req = request({ 'sb-access-token': who.tokens[who.admin]!, active_company_id: company }, 'GET') as never as {
    url: string; query: Record<string, unknown>;
  };
  req.url = url;
  req.query = query;
  const result = response();
  await (route as Route)(req as never, result.res as never);
  const state = result.state as Res;
  return { ...state, type: (result.res as { getHeader(n: string): unknown }).getHeader('content-type') };
}
const linesOf = async (run: string) => (await a.pool.query(
  `SELECT employee_id::text AS emp, paye::float8 AS paye, net_pay::float8 AS net, payslip_snapshot IS NOT NULL AS frozen
     FROM payroll_run_lines WHERE run_id = $1`, [run])).rows;

beforeAll(async () => {
  a = await rig('rlsl-paths-a');
  b = await rig('rlsl-paths-b');
  await a.setup();
  await b.setup();
  empA = (await a.employee(30000)).employee;
  await b.employee(25000);
}, 120_000);

afterAll(async () => {
  await b.teardown();
  await a.teardown();
});

describe('RLS-L: calculate, approve, payslip, IRP5 still work as app_user', () => {
  it('calculate writes the lines and approve freezes them', async () => {
    runA = await a.calculatedRun(3);
    const calc = await linesOf(runA);
    expect(calc).toHaveLength(1);
    expect(calc[0]).toMatchObject({ emp: empA, frozen: false });
    expect(calc[0]!.paye).toBeGreaterThan(0);
    const ok = await a.api.approve(runA);
    expect(ok.statusCode, JSON.stringify(ok.body)).toBe(200);
    expect((await linesOf(runA))[0]).toMatchObject({ frozen: true });
    expect((await a.header(runA)).journal_entry_id).not.toBeNull();
  });

  it('the payslip PDF, explanation, variance, cost-centre summary and IRP5 summary read them', async () => {
    const q = { id: runA };
    const pdf = await get(a, a.company, payslips, `/api/payroll/runs/${runA}/payslips`, q);
    expect(pdf.statusCode, JSON.stringify(pdf.body).slice(0, 300)).toBe(200);
    expect(pdf.type).toBe('application/pdf');
    expect((pdf.body as unknown as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const expl = await get(a, a.company, explanation, `/api/payroll/runs/${runA}/explanation`, { ...q, employeeId: empA });
    expect(expl.statusCode, JSON.stringify(expl.body)).toBe(200);
    expect(await get(a, a.company, variance, `/api/payroll/runs/${runA}/variance`, q)).toMatchObject({ statusCode: 200 });
    expect(await get(a, a.company, costCentreSummary, `/api/payroll/runs/${runA}/cost-centre-summary`, q)).toMatchObject({ statusCode: 200 });
    const irp5 = await get(a, a.company, irp5Summary, '/api/payroll/irp5/summary', { taxYear: '2027' });
    expect(irp5.statusCode, JSON.stringify(irp5.body)).toBe(200);
    const paye = (await linesOf(runA))[0]!.paye;
    expect(irp5.body.data!.totalPayeSubmitted).toBeCloseTo(paye, 2);
  });

  it('reopen clears the snapshot; recalculate and re-approve write and freeze again', async () => {
    const reopened = await a.api.reopen(runA);
    expect(reopened.statusCode, JSON.stringify(reopened.body)).toBe(200);
    expect((await linesOf(runA))[0]).toMatchObject({ frozen: false });
    const recalc = await a.api.calculate(runA);
    expect(recalc.statusCode, JSON.stringify(recalc.body)).toBe(200);
    await a.authorise(runA);
    const again = await a.api.approve(runA);
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect((await linesOf(runA))[0]).toMatchObject({ emp: empA, frozen: true });
  });
});

describe('RLS-L: tenant B gets nothing of A\'s run from the same routes', () => {
  it('B\'s user in B\'s company: every reader of A\'s run answers without A\'s lines', async () => {
    const q = { id: runA };
    const answers = await Promise.all([
      get(b, b.company, payslips, `/api/payroll/runs/${runA}/payslips`, q),
      get(b, b.company, explanation, `/api/payroll/runs/${runA}/explanation`, { ...q, employeeId: empA }),
      get(b, b.company, variance, `/api/payroll/runs/${runA}/variance`, q),
      get(b, b.company, costCentreSummary, `/api/payroll/runs/${runA}/cost-centre-summary`, q),
    ]);
    // The variance route has always answered a run it cannot find with 400 'Payroll run not found' (not this PR's).
    expect(answers.map((x) => x.statusCode)).toEqual([404, 404, 400, 404]);
    expect(JSON.stringify(answers.map((x) => x.body))).not.toContain(empA);
    const irp5 = await get(b, b.company, irp5Summary, '/api/payroll/irp5/summary', { taxYear: '2027' });
    expect(irp5.statusCode).toBe(200);
    expect(JSON.stringify(irp5.body)).not.toContain(empA);
  });

  it('B\'s user naming A\'s company is refused before any read', async () => {
    const res = await get(b, a.company, variance, `/api/payroll/runs/${runA}/variance`, { id: runA });
    expect(res.statusCode).toBe(403);
  });
});
