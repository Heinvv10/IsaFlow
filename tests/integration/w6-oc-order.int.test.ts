/**
 * Wave 6 OC, review #1620 (payroll breaker H2, L1 and its later-month repro; UI review L4), through the real routes:
 *  - pay order is creation order: a new off-cycle run paid on or before an existing non-cancelled one is refused (409);
 *  - the approval preview (journal-plan) and the MCP approve_pay_run dry run refuse what the live approval refuses;
 *  - an off-cycle run that pays nothing is not submitted for approval, nor approved;
 *  - no off-cycle run is created or costed for a month once a later month of the tax year is final.
 * The clock is SAST 2026-11-17 (Date only, advancing), so the pay-date rules hold whatever day the suite runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rig, type Route } from './brkr.helpers';
import { refusedApproval } from './w6-oc.helpers';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import approvalRequests from '../../pages/api/accounting/approval-requests';
import { approvePayRunTool } from '@/lib/mcp/tools/writePayrollRun';
import type { McpToolContext } from '@/lib/mcp/types';

vi.useFakeTimers({ now: new Date('2026-11-17T08:00:00Z'), shouldAdvanceTime: true, toFake: ['Date'] });

let a: Awaited<ReturnType<typeof rig>>;
let bonusComponent = '';
const p: Record<string, string> = {};

const create = (body: Record<string, unknown>) =>
  a.call(offCycle as Route, 'POST', '/api/payroll/runs/off-cycle', undefined, { body: { month: 11, year: 2026, ...body } });
const bonus = (who: string, runDate: string) => create({ reason: 'bonus', runDate, employees: [{ employeeId: who, componentId: bonusComponent, amount: 1_000 }] });
const runs = async () => Number((await a.pool.query('SELECT count(*)::int AS n FROM payroll_run_headers WHERE company_id = $1', [a.company])).rows[0].n);
const idOf = (r: { body: { data?: { id?: unknown } } }) => String(r.body.data!.id);

beforeAll(async () => {
  a = await rig('w6-oc-order');
  await a.setup();
  for (const k of ['first', 'second', 'third', 'late', 'zero', 'dec']) p[k] = (await a.employee(15_000)).employee;
  bonusComponent = (await a.pool.query(`INSERT INTO payroll_components (company_id, name, sars_source_code, component_type)
    VALUES ($1, 'Annual bonus', '3605', 'earning') RETURNING id`, [a.company])).rows[0].id;
  const regular = await a.calculatedRun(11);
  expect((await a.api.approve(regular)).statusCode).toBe(200);
  // Resigned after the regular run, notice served in full and no leave paid out: a termination run pays R0.
  await a.pool.query(`UPDATE payroll_employees SET end_date = '2026-11-20', termination_reason = 'resignation',
    termination_notice_period_days = 30, termination_served_notice_days = 30, termination_include_leave_payout = false WHERE id = $1`, [p.zero]);
}, 120_000);

afterAll(async () => {
  await a.pool.query('DELETE FROM payroll_off_cycle_employees WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.pool.query('DELETE FROM audit_log WHERE company_id = $1', [a.company]).catch(() => undefined);
  await a.teardown();
  vi.useRealTimers();
}, 120_000);

describe('pay order is creation order (breaker H2)', () => {
  it('a run paid on or before an existing one of the month is refused; a later one is created', async () => {
    const first = await bonus(p.first!, '2026-11-24');
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    expect((await a.api.calculate(idOf(first))).statusCode).toBe(200);
    expect((await a.api.approve(idOf(first))).statusCode).toBe(200);
    const before = await runs();
    for (const day of ['2026-11-20', '2026-11-24']) {
      const refused = await bonus(p.second!, day);
      expect(refused.statusCode, day).toBe(409);
      expect(a.msg(refused)).toMatch(/^November 2026 already has a bonus run paid on 24 Nov 2026\. A new off-cycle run must be paid after it/);
    }
    expect(await runs()).toBe(before);
    expect((await bonus(p.second!, '2026-11-25')).statusCode).toBe(201);
  });
});

describe('the approval preview and the MCP dry run refuse what approval refuses (breaker L1)', () => {
  it('a pay date passed by approval: journal-plan names it, the dry run is an error, the live call is refused', async () => {
    const made = await bonus(p.third!, '2026-11-26');
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = idOf(made);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    await a.pool.query(`UPDATE payroll_run_headers SET run_date = '2026-11-16' WHERE id = $1`, [id]);
    const plan = await a.api.preview(id);
    expect(plan.body.data?.blocker).toMatchObject({ code: 'off_cycle_not_approvable' });
    expect(String(plan.body.data?.blocker?.detail)).toMatch(/pay date \(16 Nov 2026\) is before today \(17 Nov 2026\)/);
    const ctx = { companyId: a.company, userId: a.admin, scopes: ['write:payroll'], tokenJti: null, oauthAppId: null, role: 'admin' } as McpToolContext;
    const dry = await approvePayRunTool.handler({ run_id: id, dry_run: true, idempotency_key: crypto.randomUUID() }, ctx);
    expect(dry.isError).toBe(true);
    expect(dry.content[0]!.text).toMatch(/before today/);
    expect(await refusedApproval(a, id)).toMatch(/before today/);
  });
});

describe('an off-cycle run that pays nothing (UI review L4)', () => {
  it('is not submitted for approval, nor approved', async () => {
    const made = await create({ reason: 'termination', runDate: '2026-11-27', employees: [{ employeeId: p.zero }] });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const id = idOf(made);
    expect((await a.api.calculate(id)).statusCode).toBe(200);
    expect((await a.header(id)).gross).toBe(0);
    const submitted = await a.call(approvalRequests as Route, 'POST', '/api/accounting/approval-requests', undefined, {
      body: { action: 'request', documentType: 'pay_run', documentId: id },
    });
    expect(submitted.statusCode).toBe(409);
    expect(a.msg(submitted)).toMatch(/pays nothing \(total gross R0\.00\)/);
    expect(Number((await a.pool.query('SELECT count(*)::int AS n FROM approval_requests WHERE document_id = $1', [id])).rows[0].n)).toBe(0);
    const planHash = (await a.api.preview(id)).body.data?.planHash;
    const approved = await a.api.approveWith(id, planHash, { user: a.admin });
    expect(approved.statusCode).toBe(400);
    expect(a.msg(approved)).toMatch(/pays nothing/);
  });
});

describe('a later month of the tax year is final (breaker, bonus after a later month)', () => {
  it('a November off-cycle run is neither created nor costed once December\'s run is approved', async () => {
    const open = await bonus(p.late!, '2026-11-28');
    expect(open.statusCode, JSON.stringify(open.body)).toBe(201);
    const dec = await a.calculatedRun(12);
    expect((await a.api.approve(dec)).statusCode).toBe(200);
    const before = await runs();
    const made = await bonus(p.dec!, '2026-11-29');
    expect(made.statusCode).toBe(409);
    expect(a.msg(made)).toMatch(/^December 2026's run is approved, and its PAYE year to date would miss this November 2026 off-cycle run/);
    expect(await runs()).toBe(before);
    const calc = await a.api.calculate(idOf(open));
    expect(calc.statusCode).toBe(409);
    expect(a.msg(calc)).toMatch(/Reopen December 2026's run first/);
  });
  it('an approved November bonus is not reopened once December\'s run is approved (review #1679 Codex of 7630d9379)', async () => {
    // Reopening would drop it from November's totals while recalculation and reapproval refuse it (the test above).
    const approved = String((await a.pool.query(`SELECT id FROM payroll_run_headers WHERE company_id = $1 AND run_kind = 'off_cycle'
      AND period_year = 2026 AND period_month = 11 AND status = 'approved' ORDER BY run_date DESC, created_at DESC LIMIT 1`, [a.company])).rows[0].id);
    const refused = await a.api.reopen(approved);
    expect(refused.statusCode, JSON.stringify(refused.body)).toBe(409);
    expect(a.msg(refused)).toMatch(/^December 2026's run is approved, and its PAYE year to date would miss this November 2026 off-cycle run/);
    expect((await a.pool.query('SELECT status FROM payroll_run_headers WHERE id = $1', [approved])).rows[0].status).toBe('approved');
  });
});
