/**
 * Wave 5 EX-core: a run line's explanation, stored when the run is calculated (migration 973) and read through the real
 * route (withAuth, app_user, RLS) against the disposable fixture. What is stored (each figure explained, the SDL charge
 * the run decided, results equal to the stored columns), who may read it (payroll-detail roles, a person's own session),
 * tenancy (company B's line is 404), no-store on every answer, and a line costed before the column (draft: recalculate;
 * final: the date recording began, from the column comment).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import explanation from '../../pages/api/payroll/runs/[id]/explanation';
import createRun from '../../pages/api/payroll/runs';
import { rig, type Route } from './brkr.helpers';
import { impersonationToken } from './r035-pr2.helpers';
import { callRoute } from './r035-approval.helpers';

let r: Awaited<ReturnType<typeof rig>>;
let emp = '', viewer = '', otherCompany = '', otherRun = '', otherEmp = '';
const runs: Record<string, string> = {};

async function run(year: number, month: number, approve: boolean): Promise<string> {
  const made = await r.call(createRun as Route, 'POST', '/api/payroll/runs', undefined, { body: { month, year } });
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  const id = String(made.body.data!.id);
  expect((await r.api.calculate(id)).statusCode).toBe(200);
  if (approve) {
    const approved = await r.api.approve(id);
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
  }
  return id;
}

const read = (token: string, runId: string, employeeId: string, company = r.company) =>
  callRoute(explanation as never, token, company, 'GET', undefined, `/api/payroll/runs/${runId}/explanation`, { id: runId, employeeId });
type Answer = { data: { state: string; final: boolean; recordedFrom?: string | null; explanations?: Record<string, { result: number; steps: Array<{ key: string }> }> } };
const body = (res: Awaited<ReturnType<typeof read>>) => res.state.body as Answer;

beforeAll(async () => {
  r = await rig('ex-core');
  await r.setup();
  emp = (await r.employee(30000)).employee;
  viewer = await r.addUser('viewer');
  runs.mar = await run(2026, 3, true);
  runs.apr = await run(2026, 4, false);
  otherCompany = crypto.randomUUID();
  await r.pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [otherCompany, 'EX other company']);
  otherRun = (await r.pool.query(
    `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status) VALUES ($1, 3, 2026, 'calculated') RETURNING id`,
    [otherCompany])).rows[0]!.id;
  otherEmp = (await r.pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
     VALUES ($1, 'EX-OTHER', 'Other', 'Company', '2020-01-01') RETURNING id`, [otherCompany])).rows[0]!.id;
  await r.pool.query(
    `INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay, explanation) VALUES ($1, $2, 10000, 9000, '{"schema":1}'::jsonb)`,
    [otherRun, otherEmp]);
}, 240000);

afterAll(async () => {
  await r.pool.query('DELETE FROM impersonation_sessions WHERE target_user_id = $1', [r.admin]).catch(() => undefined);
  await r.teardown([otherCompany]);
});

describe('what a calculated run stores', () => {
  it('each figure is explained, the results equal the stored columns, and SDL carries the run\'s threshold decision', async () => {
    const line = (await r.pool.query(
      'SELECT paye, uif_employee, sdl, eti, explanation FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [runs.apr, emp])).rows[0]!;
    const e = line.explanation as Answer['data']['explanations'] & { calculationVersion: number };
    expect([e!.paye!.result, e!.uif!.result, e!.sdl!.result, e!.eti!.result]).toEqual(
      [Number(line.paye), Number(line.uif_employee), Number(line.sdl), Number(line.eti)]);
    expect(e!.sdl!.steps.map(s => s.key)).toContain('sdl.charge');
    expect(e!.sdl!.steps.map(s => s.key)).not.toContain('sdl.pending');
    expect(e!.paye!.steps.map(s => s.key)).toContain('paye.annualEquivalent');
  });

  it('the route returns it, final for the approved run and draft for the calculated one', async () => {
    const final = await read(r.tokens[r.admin]!, runs.mar!, emp);
    expect(final.state.statusCode, JSON.stringify(final.state.body)).toBe(200);
    expect(body(final).data).toMatchObject({ state: 'recorded', final: true });
    const draft = await read(r.tokens[r.admin]!, runs.apr!, emp);
    expect(body(draft).data).toMatchObject({ state: 'recorded', final: false });
    expect(body(draft).data.explanations!.paye!.steps.length).toBeGreaterThan(3);
  });
});

describe('a line costed before the column', () => {
  it('reads not_recorded, with the date migration 973 recorded in the column comment', async () => {
    await r.pool.query('UPDATE payroll_run_lines SET explanation = NULL WHERE run_id = ANY($1)', [[runs.mar, runs.apr]]);
    const final = body(await read(r.tokens[r.admin]!, runs.mar!, emp)).data;
    const draft = body(await read(r.tokens[r.admin]!, runs.apr!, emp)).data;
    expect(final).toMatchObject({ state: 'not_recorded', final: true });
    expect(final.recordedFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(draft).toMatchObject({ state: 'not_recorded', final: false });
  });
});

describe('who may read it', () => {
  it('company B\'s line is 404, by its run or by its employee on our run', async () => {
    expect((await read(r.tokens[r.admin]!, otherRun, otherEmp)).state.statusCode).toBe(404);
    expect((await read(r.tokens[r.admin]!, runs.mar!, otherEmp)).state.statusCode).toBe(404);
  });

  it('an employee not on the run, and a cancelled run, are 404', async () => {
    expect((await read(r.tokens[r.admin]!, runs.mar!, crypto.randomUUID())).state.statusCode).toBe(404);
    const id = await run(2026, 5, false);
    await r.pool.query(`UPDATE payroll_run_headers SET status = 'cancelled' WHERE id = $1`, [id]);
    expect((await read(r.tokens[r.admin]!, id, emp)).state.statusCode).toBe(404);
  });

  it('a viewer is 403', async () => {
    expect((await read(r.tokens[viewer]!, runs.mar!, emp)).state.statusCode).toBe(403);
  });

  it('a token channel (claims with no session id) is 403 AGENT_FORBIDDEN', async () => {
    const token = await new SignJWT({ sub: r.admin, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const res = await read(token, runs.mar!, emp);
    expect(res.state.statusCode).toBe(403);
    expect((res.state.body as { error: { details: { reason: string } } }).error.details.reason).toBe('AGENT_FORBIDDEN');
  });

  it('a Login-as may read one employee\'s line', async () => {
    const token = await impersonationToken(r.pool, r.admin, r.approver);
    expect((await read(token, runs.mar!, emp)).state.statusCode).toBe(200);
  });

  it('every answer carries Cache-Control: no-store', async () => {
    const answers = [
      await read(r.tokens[r.admin]!, runs.mar!, emp),
      await read(r.tokens[r.admin]!, otherRun, otherEmp),
      await read(r.tokens[viewer]!, runs.mar!, emp),
      await callRoute(explanation as never, r.tokens[r.admin]!, r.company, 'GET', undefined, `/api/payroll/runs/${runs.mar}/explanation`, { id: runs.mar!, employeeId: 'nope' }),
    ];
    expect(answers.map(a => a.state.statusCode)).toEqual([200, 404, 403, 400]);
    for (const a of answers) expect(a.headers.get('cache-control')).toBe('no-store');
  });
});
