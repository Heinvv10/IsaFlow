/**
 * End (DELETE /api/payroll/employees/:id/components?aid=…, MCP end_employee_component) runs the same guards as Edit
 * dates, in one shared function (security review round 2, 2026-11-02): refused for a voided row, an end before the
 * start, an end LATER than the row's current end (End only shortens), a change to what a paid run paid. Since
 * migration 953 a supersede is recorded (superseded_at) rather than inferred from a neighbour, so ending or moving a
 * neighbour cannot make a replaced once-off payable again and is not refused (payroll-component-superseded.int).
 * Every accepted End or cancel is in audit_log with the actor: the route's user, the MCP caller.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { authorisePayRun, calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import components from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { endEmployeeComponentTool } from '@/lib/mcp/tools/writeEmployees';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const admin = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let employee = '';
const row: Record<string, string> = {};
const ctx = () => ({ companyId: company, userId: admin, scopes: ['write:payroll'], companyRole: 'owner', tokenJti: null, oauthAppId: null });

const url = (aid: string) => `/api/payroll/employees/${employee}/components?aid=${aid}`;
const end = (aid: string, effectiveTo: string) => call(components as Route, 'DELETE', url(aid), employee, { body: { effectiveTo }, query: { aid } });
const patch = (aid: string, body: unknown) => call(components as Route, 'PATCH', url(aid), employee, { body, query: { aid } });
async function mcpEnd(aid: string, effectiveTo: string): Promise<{ isError?: boolean; text: string }> {
  const out = await endEmployeeComponentTool.handler(
    { assignment_id: aid, effective_to: effectiveTo, idempotency_key: crypto.randomUUID() }, ctx() as never) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: out.isError, text: out.content[0]!.text };
}
const datesOf = async (id: string) => (await pool.query(
  "SELECT to_char(effective_from,'YYYY-MM-DD') AS f, to_char(effective_to,'YYYY-MM-DD') AS t FROM payroll_employee_components WHERE id=$1", [id])).rows[0];
const audits = async (id: string) => (await pool.query(
  "SELECT user_id, changes FROM audit_log WHERE company_id=$1 AND entity_type='payroll_employee_component' AND entity_id=$2 ORDER BY created_at", [company, id])).rows;

async function add(key: string, component: string, amount: number, from: string, to: string | null, recurring: boolean) {
  row[key] = String((await pool.query(
    `INSERT INTO payroll_employee_components(employee_id,component_id,amount,effective_from,effective_to,is_recurring)
     VALUES($1,$2,$3,$4::date,$5::date,$6) RETURNING id`, [employee, component, amount, from, to, recurring])).rows[0]!.id);
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'End guards']);
  row.salary = await seedPayrollCompany(pool, company);
  employee = String((await pool.query('SELECT employee_id FROM payroll_employee_components WHERE id=$1', [row.salary])).rows[0]!.employee_id);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [admin, `${admin}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, admin]);
  const token = await new SignJWT({ sub: admin, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [admin]: token }, { user: admin, company });
  const [bonus, allowance, travel, commission] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const [id, name, code] of [[bonus, 'Bonus', '3605'], [allowance, 'Allowance', '3713'], [travel, 'Travel', '3701'], [commission, 'Commission', '3606']]) {
    await pool.query("INSERT INTO payroll_components(id,company_id,name,sars_source_code,component_type) VALUES($1,$2,$3,$4,'earning')", [id, company, name, code]);
  }
  await add('endedAllowance', allowance, 500, '2025-01-01', '2026-04-30', true);
  await add('futureTravel', travel, 400, '2026-06-01', null, true);
  await add('voided', bonus, 900, '2026-08-20', '2026-08-19', false);
  await add('openTravelOld', travel, 300, '2025-01-01', '2026-05-31', true);
  // A once-off replaced in its month (a package re-applied on the 15th): the old row ends the day before the new one.
  await add('replaced', bonus, 1200, '2026-07-01', '2026-07-14', false);
  await add('replacement', bonus, 1200, '2026-07-15', '2026-07-31', false);
  await add('mcpOnceOff', bonus, 250, '2026-09-10', '2026-09-30', false);
  // A once-off covering its month's last day is paid whether or not a row follows it.
  await add('fullMonthOnceOff', commission, 800, '2026-10-01', '2026-10-31', false);
  await add('nextCommission', commission, 900, '2026-11-01', null, true);

  const feb = await calculatedRun(call, 2);
  const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${feb}/journal-plan`, feb);
  await authorisePayRun(call, feb);
  const approved = await call(approve as Route, 'POST', `/api/payroll/runs/${feb}/approve`, feb, { body: { expectedPlanHash: plan.body.data?.planHash } });
  expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM audit_log WHERE company_id=$1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [admin]);
  } finally { await pool.end(); }
});

const REFUSED: Array<[string, string, string, RegExp]> = [
  ['an end later than the current end (End only shortens)', 'endedAllowance', '2026-06-30', /only bring.*earlier/i],
  // A row no paid run read is cancelled instead (L1, payroll-approval-recalc-gates.int).
  ['an end before the start of a row a paid run read', 'salary', '2019-12-31', /before its start.*a paid run read it/i],
  ['an end that takes a paid month out', 'salary', '2026-01-31', /2026-02 .*already paid/i],
  ['a voided row', 'voided', '2026-08-25', /cancelled/i],
];

describe.each([['REST', 'rest'], ['MCP', 'mcp']] as const)('End through %s refuses, nothing written', (_n, path) => {
  it.each(REFUSED)('%s', async (_c, key, to, message) => {
    const before = await datesOf(row[key]!);
    if (path === 'rest') {
      const out = await end(row[key]!, to);
      expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
      expect(out.body.error?.message).toMatch(message);
    } else {
      const out = await mcpEnd(row[key]!, to);
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(message);
    }
    expect(await datesOf(row[key]!)).toEqual(before);
  });
});

describe('accepted, and audited with the actor', () => {
  it('REST End shortens an open row: the route user, effective_to before and after', async () => {
    expect((await end(row.openTravelOld!, '2026-04-30')).statusCode).toBe(200);
    expect(await datesOf(row.openTravelOld!)).toEqual({ f: '2025-01-01', t: '2026-04-30' });
    const [a] = await audits(row.openTravelOld!);
    expect(a.user_id).toBe(admin);
    expect(a.changes.fields).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'effective_to', old: '2026-05-31', new: '2026-04-30' })]));
  });

  it('MCP End on an unpaid once-off cancels it: voided, audited as a cancel with the MCP caller', async () => {
    const out = await mcpEnd(row.mcpOnceOff!, '2026-09-20');
    expect(out.isError).toBeFalsy();
    const d = await datesOf(row.mcpOnceOff!);
    expect(d.t < d.f).toBe(true);
    const [a] = await audits(row.mcpOnceOff!);
    expect(a.user_id).toBe(admin);
    expect(a.changes.metadata).toMatchObject({ kind: 'cancel', channel: 'mcp' });
  });

  it("moving the row after a full-month once-off: allowed, that once-off is paid in October either way", async () => {
    const out = await patch(row.nextCommission!, { effectiveFrom: '2026-11-02', effectiveTo: null });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
  });

  it('the replaced once-off can be cancelled first, then its replacement', async () => {
    expect((await end(row.replaced!, '2026-07-10')).statusCode).toBe(200);
    expect((await end(row.replacement!, '2026-07-20')).statusCode).toBe(200);
    for (const k of ['replaced', 'replacement']) {
      const d = await datesOf(row[k]!);
      expect(d.t < d.f).toBe(true);
    }
  });
});
