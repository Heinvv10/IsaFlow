/**
 * Wave 6 OC (review #1620 L3, spec rule 14): creating an off-cycle run is a money-moving write, refused under a
 * platform-admin Login-as session (403 IMPERSONATION_FORBIDDEN) before any read or write; the target's own session
 * reaches the service's own judgement. Cancel run and a bonus amount change likewise. Approving one is refused by approvePayrollRun's guard (r-032-l5).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import offCycle from '../../pages/api/payroll/runs/off-cycle';
import cancel from '../../pages/api/payroll/runs/[id]/cancel';
import amounts from '../../pages/api/payroll/runs/[id]/off-cycle-amounts';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'OC Login-as');
const BODY = { month: 11, year: 2026, reason: 'bonus', runDate: '2099-11-27', employees: [{ employeeId: crypto.randomUUID(), componentId: crypto.randomUUID(), amount: 10 }] };
const headers = async () => Number((await pool.query('SELECT count(*)::int AS n FROM payroll_run_headers WHERE company_id = $1', [fx.company])).rows[0].n);

beforeAll(async () => { await fx.setUp(); }, 60_000);
afterAll(async () => { try { await fx.tearDown(); } finally { await pool.end(); } });

describe('off-cycle run create under Login-as', () => {
  it('403 IMPERSONATION_FORBIDDEN, nothing written', async () => {
    const loginAs = await fx.loginAsTarget();
    const before = await headers();
    const r = await fx.call(offCycle as never, loginAs, { method: 'POST', body: BODY, url: '/api/payroll/runs/off-cycle' });
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await headers()).toBe(before);
  });

  it('Cancel run: 403 IMPERSONATION_FORBIDDEN, before any read (UI review #1620 H)', async () => {
    const loginAs = await fx.loginAsTarget();
    const id = crypto.randomUUID();
    const r = await fx.call(cancel as never, loginAs, { method: 'POST', query: { id }, url: `/api/payroll/runs/${id}/cancel` });
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
  });

  it('a bonus amount change: 403 IMPERSONATION_FORBIDDEN, before any read (review #1620 final breaker M)', async () => {
    const loginAs = await fx.loginAsTarget();
    const id = crypto.randomUUID();
    const r = await fx.call(amounts as never, loginAs, {
      method: 'PATCH', query: { id }, url: `/api/payroll/runs/${id}/off-cycle-amounts`, body: { employeeId: crypto.randomUUID(), amount: 5 },
    });
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
    // The target's own session reaches the service: no such run here, a 404.
    const own = await fx.call(amounts as never, await fx.ownSession(), {
      method: 'PATCH', query: { id }, url: `/api/payroll/runs/${id}/off-cycle-amounts`, body: { employeeId: crypto.randomUUID(), amount: 5 },
    });
    expect(own.state.statusCode, JSON.stringify(own.state.body)).toBe(404);
  });

  it('the target\'s own session reaches the service (here a 400 on the pay date\'s month, not a 403)', async () => {
    const own = await fx.ownSession();
    const r = await fx.call(offCycle as never, own, { method: 'POST', body: BODY, url: '/api/payroll/runs/off-cycle' });
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(400);
  });
});
