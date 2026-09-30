/**
 * W3-01 review round 1 — GET /api/payroll/runs/[id]/journal-plan through the
 * real chain: withAuth (cookie JWT, membership, app_user + RLS), withErrorHandler,
 * the route's role gate, and the real previewPayrollApproval against Postgres.
 *
 * The cross-company case uses a user who belongs to BOTH companies, with A
 * active. RLS (company_id IN the user's companies) then lets B's run through,
 * so the only thing standing between A's session and B's payroll is the
 * route asking with A's company id. A user of A alone would get 404 from RLS
 * even with that scoping removed, which would prove nothing about the route.
 *
 * The runs are draft headers exactly as POST /api/payroll/runs writes them
 * (createPayrollRun: company, period, every total at its default). Round 2
 * dropped a 'paid' run here: no code path ever writes 'paid' (nor 'cancelled')
 * to payroll_run_headers, so the status gate's parity is proven on a state the
 * product does reach, in brk596-approve-preview.int.test.ts REPRO 2.
 *
 * Disposable DB only (assertDisposable): a localhost isaflow_schema_fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request } from './mfa-impersonation-postgres.helpers';
import { call } from './r159-auth-wrapper.helpers';
import handler from '../../pages/api/payroll/runs/[id]/journal-plan';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const CO_A = randomUUID();
const CO_B = randomUUID();
const MANAGER = randomUUID(); // member of A and B
const VIEWER = randomUUID(); // viewer in A
const RUN_A = randomUUID();
const RUN_B = randomUUID();
const tokens: Record<string, string> = {};

const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));

function get(user: string, id: string, method = 'GET') {
  const req = request({ 'sb-access-token': tokens[user]!, active_company_id: CO_A }, method) as unknown as Record<string, unknown>;
  return call(handler as never, { ...req, url: `/api/payroll/runs/${id}/journal-plan`, query: { id } });
}

beforeAll(async () => {
  for (const [id, name] of [[CO_A, 'W3-01 A'], [CO_B, 'W3-01 B']]) {
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [id, name]);
  }
  for (const [id, role] of [[MANAGER, 'manager'], [VIEWER, 'viewer']] as const) {
    await pool.query('INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)',
      [id, `w301-${id}@isaflow.test`, role]);
    tokens[id] = await sign(id);
  }
  await pool.query(
    `INSERT INTO company_users (company_id, user_id, role, is_default) VALUES
       ($1, $3, 'manager', true), ($2, $3, 'manager', false), ($1, $4, 'viewer', true)`,
    [CO_A, CO_B, MANAGER, VIEWER]);
  await pool.query(
    `INSERT INTO payroll_run_headers (id, company_id, period_month, period_year)
     VALUES ($1, $2, 9, 2026), ($3, $4, 9, 2026)`,
    [RUN_A, CO_A, RUN_B, CO_B]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_run_headers WHERE id IN ($1, $2)', [RUN_A, RUN_B]);
    await pool.query('DELETE FROM company_users WHERE company_id IN ($1, $2)', [CO_A, CO_B]);
    await pool.query('DELETE FROM companies WHERE id IN ($1, $2)', [CO_A, CO_B]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [MANAGER, VIEWER]);
  } finally {
    await pool.end();
  }
});

describe('GET /api/payroll/runs/[id]/journal-plan — real withAuth chain', () => {
  it("200 with the plan for the caller's own run", async () => {
    const r = await get(MANAGER, RUN_A);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ data: { plan: { runId: RUN_A, status: 'draft' } } });
  });

  it("404 for another company's run, even to a member of both (A active)", async () => {
    const r = await get(MANAGER, RUN_B);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toContain('"plan"');
  });

  it('404 for an id that is no run at all', async () => {
    expect((await get(MANAGER, randomUUID())).status).toBe(404);
  });

  it('400 for a malformed id', async () => {
    expect((await get(MANAGER, 'not-a-uuid')).status).toBe(400);
  });

  it('405 for POST', async () => {
    expect((await get(MANAGER, RUN_A, 'POST')).status).toBe(405);
  });

  it('403 for a viewer', async () => {
    expect((await get(VIEWER, RUN_A)).status).toBe(403);
  });
});
