/**
 * W29 (wave 7 PRA; review #1901 M2, coordinator decision A) through the real routes. A line that pays a recurring
 * earning its share beside a once-off earning is refused at approval (`recurring_share_beside_once_off`) until an owner or
 * admin acknowledges it on the run (POST /api/payroll/runs/[id]/recurring-share, one audit_log row). The same refusal
 * reaches the approval preview, the approve route and the MCP approve_pay_run tool. A recalculation that changes either
 * side of the pair needs a new acknowledgement. A refused acknowledgement writes nothing; another company's row acks nothing.
 * November 2026: 21 working days; a raise from Monday 16 November pays 10 + 11 of them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import share from '../../pages/api/payroll/runs/[id]/recurring-share';
import { approvePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
import type { McpToolContext } from '@/lib/mcp/types';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let run = '';
let bonusRow = '';
const p: Record<string, string> = {};
const url = () => `/api/payroll/runs/${run}/recurring-share`;
const get = () => a.call(share as Route, 'GET', url(), run);
const ack = (employeeId: unknown, o: { user?: string } = {}) => a.call(share as Route, 'POST', url(), run, { ...o, body: { employeeId } });
const acks = async () => Number((await a.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE company_id=$1 AND entity_type='recurring_share_ack'", [a.company])).rows[0].n);
const blocker = async () => (await a.api.preview(run)).body.data?.blocker as { code: string; detail: string } | null | undefined;
const mcpCtx = () => ({ companyId: a.company, userId: a.admin, scopes: ['write:payroll'], tokenJti: null, oauthAppId: null, role: 'admin' } as McpToolContext);

beforeAll(async () => {
  a = await rig('w7-pra-share-ack');
  await a.setup();
  const raise = await a.employee(20_000);
  p.raise = raise.employee;
  await a.pool.query("UPDATE payroll_employee_components SET effective_to='2026-11-15' WHERE id=$1", [raise.salaryRow]);
  const basic = (await a.pool.query('SELECT component_id FROM payroll_employee_components WHERE id=$1', [raise.salaryRow])).rows[0].component_id;
  await a.pool.query(`INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,is_recurring) VALUES($1,$2,22000,'2026-11-16',true)`, [p.raise, basic]);
  const bonus = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type) VALUES ($1,'Annual bonus','3605','earning') RETURNING id`, [a.company])).rows[0].id;
  bonusRow = (await a.pool.query(`INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
    VALUES($1,$2,1000,'2026-11-01','2026-11-30',false) RETURNING id`, [p.raise, bonus])).rows[0].id;
  // A raise with no once-off beside it: paid its shares, nothing to acknowledge.
  const plain = await a.employee(20_000);
  p.plain = plain.employee;
  await a.pool.query("UPDATE payroll_employee_components SET effective_to='2026-11-15' WHERE id=$1", [plain.salaryRow]);
  await a.pool.query(`INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,is_recurring) VALUES($1,$2,22000,'2026-11-16',true)`, [p.plain, basic]);
  const made = await a.api.createRun(11);
  expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
  run = String(made.body.data!.id);
  expect((await a.api.calculate(run)).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('a share beside a once-off earning', () => {
  it('the line pays both shares; the run lists the pair for that employee only', async () => {
    const gross = (await a.pool.query('SELECT gross_pay::float8 AS g FROM payroll_run_lines WHERE run_id=$1 AND employee_id=$2', [run, p.raise])).rows[0].g;
    expect(gross).toBe(Math.round(20_000 * 10 / 21 * 100) / 100 + Math.round(22_000 * 11 / 21 * 100) / 100 + 1000);
    const pairs = (await get()).body.data!.pairs as Array<{ employeeId: string; acknowledged: boolean; message: string }>;
    expect(pairs.map((x) => [x.employeeId, x.acknowledged])).toEqual([[p.raise, false]]);
    expect(pairs[0]!.message).toContain('Annual bonus 1000.00');
  });

  it('refuses approval in the preview, the approve route and the MCP approve_pay_run tool, naming the employee', async () => {
    const b = await blocker();
    expect(b?.code).toBe('recurring_share_beside_once_off');
    const number = (await a.pool.query('SELECT employee_number FROM payroll_employees WHERE id=$1', [p.raise])).rows[0].employee_number;
    expect(b!.detail).toContain(number);
    const plainNumber = (await a.pool.query('SELECT employee_number FROM payroll_employees WHERE id=$1', [p.plain])).rows[0].employee_number;
    expect(b!.detail).not.toContain(`${plainNumber}.`);
    expect((await a.api.approveOnly(run)).statusCode).toBe(400);
    const dry = await approvePayRunTool.handler({ run_id: run, dry_run: true, idempotency_key: crypto.randomUUID() }, mcpCtx());
    expect(dry.isError).toBe(true);
    expect(dry.content[0]!.text).toContain('beside a once-off earning');
  });

  it('a refused acknowledgement writes nothing: a viewer (403), a bad body (400), an employee with no pair (409)', async () => {
    const viewer = await a.addUser('viewer');
    expect((await ack(p.raise, { user: viewer })).statusCode).toBe(403);
    expect((await a.call(share as Route, 'POST', url(), run, { body: { employeeId: p.raise, extra: 1 } })).statusCode).toBe(400);
    expect((await ack(p.plain)).statusCode).toBe(409);
    expect(await acks()).toBe(0);
  });

  it("another company's acknowledgement row for this run acks nothing", async () => {
    const other = crypto.randomUUID();
    await a.pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'W7 PRA other tenant']);
    const key = (await a.pool.query(`SELECT v->>'pairKey' AS k FROM payroll_run_lines l, jsonb_path_query(l.validation_results, '$[*] ? (@.code == "RECURRING_SHARE_BESIDE_ONCE_OFF")') v WHERE l.run_id=$1`, [run])).rows[0].k;
    await a.pool.query(`INSERT INTO audit_log(company_id,user_id,action,entity_type,entity_id,changes) VALUES($1,$2,'approve','recurring_share_ack',$3,$4)`,
      [other, a.admin, run, JSON.stringify({ metadata: { employeeId: p.raise, pairKey: key } })]);
    expect((await blocker())?.code).toBe('recurring_share_beside_once_off');
    await a.pool.query('DELETE FROM audit_log WHERE company_id=$1', [other]);
    await a.pool.query('DELETE FROM companies WHERE id=$1', [other]);
  });

  it('an owner or admin acknowledges it (one audit row); the refusal clears', async () => {
    const r = await ack(p.raise);
    expect(r.statusCode, JSON.stringify(r.body)).toBe(200);
    expect(await acks()).toBe(1);
    expect(((await get()).body.data!.pairs as Array<{ acknowledged: boolean }>).map((x) => x.acknowledged)).toEqual([true]);
    expect((await blocker())?.code ?? null).not.toBe('recurring_share_beside_once_off');
    expect((await ack(p.raise)).statusCode).toBe(409); // nothing left to acknowledge
  });

  it('a recalculation that changes the once-off needs a new acknowledgement', async () => {
    await a.pool.query('UPDATE payroll_employee_components SET amount=1500 WHERE id=$1', [bonusRow]);
    expect((await a.api.calculate(run)).statusCode).toBe(200);
    expect((await blocker())?.code).toBe('recurring_share_beside_once_off');
    expect((await ack(p.raise)).statusCode).toBe(200);
    expect(await acks()).toBe(2);
  });

  it('with every pair acknowledged the run approves; afterwards nothing is acknowledged', async () => {
    const approved = await a.api.approve(run);
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
    expect((await ack(p.raise)).statusCode).toBe(409);
    expect(await acks()).toBe(2);
  });
});
