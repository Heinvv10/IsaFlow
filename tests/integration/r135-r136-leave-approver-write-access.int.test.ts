/**
 * Payroll leave cluster, driven through the real routes (withAuth as app_user
 * with RLS and the membership check, withErrorHandler, withCsrf).
 *
 * R-135: PUT /api/payroll/leave/[id] stored `approvedBy` from the request body,
 *   so any caller could name any approver. The approver is now the session
 *   user; a body value is ignored.
 * R-136: the same route had no withWriteAccess, so a viewer could approve,
 *   reject, cancel or delete leave. The create routes (POST /api/payroll/leave,
 *   POST /api/payroll/leave/types) had the same gap. Viewers now get 403 before
 *   any write; owner/admin/manager still write.
 * R-122 (not reproduced — 397 already replaced 396's JWT-claim policies): as
 *   app_user with withAuth's GUCs, own-company leave is visible and another
 *   company's is not, and a create in the active company lands.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import type { NextApiHandler } from 'next';
import leaveById from '../../pages/api/payroll/leave/[id]';
import leaveIndex from '../../pages/api/payroll/leave/index';
import leaveTypes from '../../pages/api/payroll/leave/types';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

const CO = randomUUID();
const OTHER_CO = randomUUID();
const ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
type Role = (typeof ROLES)[number];
const userOf = {} as Record<Role, string>;
const jwtOf = {} as Record<Role, string>;
const otherOwner = randomUUID();
const employee = randomUUID();
const otherEmployee = randomUUID();
const leaveType = randomUUID();
const otherLeaveType = randomUUID();
const otherLeave = randomUUID();

const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

async function call(handler: NextApiHandler, role: Role, method: string, query: Record<string, string>, body?: unknown) {
  const req = request({ 'sb-access-token': jwtOf[role], active_company_id: CO }, method) as never as {
    body: unknown; query: Record<string, string>; url: string;
  };
  req.body = body;
  req.query = query;
  req.url = '/api/payroll/leave/r135';
  const out = response();
  await handler(req as never, out.res);
  return out.state as { statusCode: number; body: unknown };
}

async function pendingLeave(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO payroll_leave_requests(id,company_id,employee_id,leave_type_id,start_date,end_date,days,status)
    VALUES($1,$2,$3,$4,'2026-10-01','2026-10-02',2,'pending')`, [id, CO, employee, leaveType]);
  return id;
}

const row = async (id: string) => (await pool.query(
  'SELECT status, approved_by, approved_at FROM payroll_leave_requests WHERE id=$1', [id])).rows[0] as
  { status: string; approved_by: string | null; approved_at: Date | null } | undefined;

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
    [CO, 'R135 leave', OTHER_CO, 'R135 other company']);
  for (const role of ROLES) {
    userOf[role] = randomUUID();
    await pool.query('INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)',
      [userOf[role], `r135-${role}-${userOf[role]}@isaflow.test`, role === 'viewer' ? 'viewer' : 'admin']);
    await pool.query('INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)',
      [CO, userOf[role], role]);
    jwtOf[role] = await sign(userOf[role]);
  }
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [otherOwner, `r135-other-${otherOwner}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)",
    [OTHER_CO, otherOwner]);
  await pool.query(`INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date, medical_aid_main_member)
    VALUES($1,$2,'R135','Lee','Ave','2026-01-01', true), ($3,$4,'R135X','Kim','Other','2026-01-01', true)`,
  [employee, CO, otherEmployee, OTHER_CO]);
  await pool.query('INSERT INTO payroll_leave_types(id,company_id,name) VALUES($1,$2,$3), ($4,$5,$6)',
    [leaveType, CO, 'Annual', otherLeaveType, OTHER_CO, 'Annual']);
  await pool.query(`INSERT INTO payroll_leave_requests(id,company_id,employee_id,leave_type_id,start_date,end_date,days,status)
    VALUES($1,$2,$3,$4,'2026-10-05','2026-10-06',2,'pending')`, [otherLeave, OTHER_CO, otherEmployee, otherLeaveType]);
});

afterAll(async () => {
  try {
    for (const t of ['payroll_leave_requests', 'payroll_leave_types', 'payroll_employees', 'audit_log', 'company_users']) {
      await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[CO, OTHER_CO]]);
    }
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[CO, OTHER_CO]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[...Object.values(userOf), otherOwner]]);
  } finally { await pool.end(); }
});

describe('R-135 — the leave approver is the session user, never the body', () => {
  it('approving with a forged approvedBy stores the session user', async () => {
    const id = await pendingLeave();
    const forged = userOf.admin;
    const state = await call(leaveById, 'owner', 'PUT', { id }, { status: 'approved', approvedBy: forged });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    const after = await row(id);
    expect(after?.status).toBe('approved');
    expect(after?.approved_by).toBe(userOf.owner);
    expect(after?.approved_at).not.toBeNull();
  });

  it('approving with an approvedBy from outside the company stores the session user', async () => {
    const id = await pendingLeave();
    const state = await call(leaveById, 'manager', 'PUT', { id }, { status: 'approved', approvedBy: randomUUID() });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect((await row(id))?.approved_by).toBe(userOf.manager);
  });

  it.each(['rejected', 'cancelled'] as const)('%s with a forged approvedBy stores no approver', async (status) => {
    const id = await pendingLeave();
    const state = await call(leaveById, 'owner', 'PUT', { id }, { status, approvedBy: userOf.admin });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    const after = await row(id);
    expect(after?.status).toBe(status);
    expect(after?.approved_by).toBeNull();
    expect(after?.approved_at).toBeNull();
  });
});

describe('R-136 — leave writes are limited to owner/admin/manager', () => {
  it.each(['owner', 'admin', 'manager'] as const)('a %s approves (200)', async (role) => {
    const id = await pendingLeave();
    const state = await call(leaveById, role, 'PUT', { id }, { status: 'approved' });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect((await row(id))?.status).toBe('approved');
  });

  it.each(['approved', 'rejected', 'cancelled'] as const)('refuses a viewer who PUTs %s (403), nothing written', async (status) => {
    const id = await pendingLeave();
    const state = await call(leaveById, 'viewer', 'PUT', { id }, { status });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(403);
    expect(await row(id)).toEqual({ status: 'pending', approved_by: null, approved_at: null });
  });

  it('refuses a viewer DELETE (403) and the request stays', async () => {
    const id = await pendingLeave();
    const state = await call(leaveById, 'viewer', 'DELETE', { id });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(403);
    expect((await row(id))?.status).toBe('pending');
  });

  it('a manager DELETEs a pending request (200)', async () => {
    const id = await pendingLeave();
    const state = await call(leaveById, 'manager', 'DELETE', { id });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await row(id)).toBeUndefined();
  });

  it('a viewer cannot GET a request (403): leave is per-employee data, for write roles (D3, 2026-10-02)', async () => {
    const id = await pendingLeave();
    const state = await call(leaveById, 'viewer', 'GET', { id });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(403);
    expect((await call(leaveById, 'owner', 'GET', { id })).statusCode).toBe(200);
  });

  const createBody = () => ({ employeeId: employee, leaveTypeId: leaveType, startDate: '2026-11-02',
    endDate: '2026-11-03', days: 2, reason: `r136-${randomUUID()}` });
  const countByReason = async (reason: string) => Number((await pool.query(
    'SELECT count(*) AS n FROM payroll_leave_requests WHERE company_id=$1 AND reason=$2', [CO, reason])).rows[0].n);

  it('refuses a viewer creating a leave request (403), nothing written', async () => {
    const body = createBody();
    const state = await call(leaveIndex, 'viewer', 'POST', {}, body);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(403);
    expect(await countByReason(body.reason)).toBe(0);
  });

  it.each(['owner', 'admin', 'manager'] as const)('a %s creates a leave request (201)', async (role) => {
    const body = createBody();
    const state = await call(leaveIndex, role, 'POST', {}, body);
    expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
    expect(await countByReason(body.reason)).toBe(1);
  });

  const typeCount = async (name: string) => Number((await pool.query(
    'SELECT count(*) AS n FROM payroll_leave_types WHERE company_id=$1 AND name=$2', [CO, name])).rows[0].n);

  it('refuses a viewer creating a leave type (403), nothing written', async () => {
    const name = `R136 viewer ${randomUUID().slice(0, 8)}`;
    const state = await call(leaveTypes, 'viewer', 'POST', {}, { name, accrualRule: 'none' });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(403);
    expect(await typeCount(name)).toBe(0);
  });

  it.each(['owner', 'admin', 'manager'] as const)('a %s creates a leave type (201)', async (role) => {
    const name = `R136 ${role} ${randomUUID().slice(0, 8)}`;
    const state = await call(leaveTypes, role, 'POST', {}, { name, accrualRule: 'none' });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
    expect(await typeCount(name)).toBe(1);
  });
});

describe('R-122 — leave RLS as app_user with withAuth GUCs (not reproduced; pinned)', () => {
  async function asAppUser<T>(userId: string, companyId: string, fn: (q: Pool['query']) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
      return await fn(client.query.bind(client) as Pool['query']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('sees its own company leave and none of another company', async () => {
    const own = await pendingLeave();
    const seen = await asAppUser(userOf.owner, CO, async (q) => (await q(
      'SELECT id, company_id FROM payroll_leave_requests WHERE id = ANY($1)', [[own, otherLeave]])).rows);
    expect(seen).toEqual([{ id: own, company_id: CO }]);
    const types = await asAppUser(userOf.owner, CO, async (q) => (await q(
      'SELECT id FROM payroll_leave_types WHERE id = ANY($1)', [[leaveType, otherLeaveType]])).rows);
    expect(types).toEqual([{ id: leaveType }]);
  });

  it('cannot insert leave into another company', async () => {
    await expect(asAppUser(userOf.owner, CO, (q) => q(
      `INSERT INTO payroll_leave_requests(company_id,employee_id,leave_type_id,start_date,end_date,days)
       VALUES($1,$2,$3,'2026-12-01','2026-12-01',1)`, [OTHER_CO, otherEmployee, otherLeaveType])))
      .rejects.toThrow(/row-level security/);
  });

  it('the list route returns own-company leave only, and another company’s id is 404', async () => {
    const own = await pendingLeave();
    expect((await call(leaveIndex, 'viewer', 'GET', {})).statusCode).toBe(403);
    const list = await call(leaveIndex, 'owner', 'GET', {});
    expect(list.statusCode, JSON.stringify(list.body)).toBe(200);
    const ids = ((list.body as { data: Array<{ id: string }> }).data).map((r) => r.id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(otherLeave);
    const foreign = await call(leaveById, 'owner', 'GET', { id: otherLeave });
    expect(foreign.statusCode).toBe(404);
  });
});
