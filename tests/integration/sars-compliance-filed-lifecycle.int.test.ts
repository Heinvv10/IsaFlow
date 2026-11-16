/**
 * "Marked filed" and the session/company lifecycle:
 *   - a Login-as session is refused (403 IMPERSONATION_FORBIDDEN) on POST and DELETE, writing nothing;
 *     the target's own session may mark;
 *   - the admin delete of a company with a mark present succeeds (a soft delete: the mark stays with
 *     the company row, and no FK refuses it).
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import filedRoute from '../../pages/api/accounting/sars/compliance-filed';
import { deleteCompany } from '@/modules/admin/services/companyLifecycleService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf, type Jar } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'SARS filed Login-as');
const Y = new Date().getFullYear();
const MAR = { eventType: 'EMP201_DUE', periodEnd: `${Y}-03-31` };
const APR = { eventType: 'EMP201_DUE', periodEnd: `${Y}-04-30` };
let loginAs: Jar;

const marks = async () => (await pool.query(
  'SELECT event_type, period_end::text AS period_end FROM sars_compliance_events WHERE company_id = $1 ORDER BY period_end', [fx.company])).rows;
const call = (jar: Jar, method: string, body: unknown) =>
  fx.call(filedRoute as never, jar, { method, body, url: '/api/accounting/sars/compliance-filed' });

beforeAll(async () => {
  await fx.setUp();
  loginAs = await fx.loginAsTarget();
  // A mark for the DELETE refusal, written as the target (the stamp trigger needs a session user).
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.target })]);
    await c.query(`INSERT INTO sars_compliance_events (company_id, event_type, due_date, period_start, period_end, description, status)
                   VALUES ($1, 'EMP201_DUE', $2, $3, $4, 'EMP201 for March', 'completed')`,
      [fx.company, `${Y}-04-07`, `${Y}-03-01`, `${Y}-03-31`]);
    await c.query('COMMIT');
  } finally { c.release(); }
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM sars_compliance_events WHERE company_id = $1', [fx.company]);
    await fx.tearDown();
  } finally { await pool.end(); }
});

describe('Login-as is refused', () => {
  it('POST: 403, nothing written', async () => {
    const before = await marks();
    const r = await call(loginAs, 'POST', APR);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await marks()).toEqual(before);
  });

  it('DELETE: 403, the mark stays', async () => {
    const before = await marks();
    const r = await call(loginAs, 'DELETE', MAR);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(403);
    expect(reasonOf(r)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await marks()).toEqual(before);
  });

  it("the target's own session may mark", async () => {
    const r = await call(await fx.ownSession(), 'POST', APR);
    expect(r.state.statusCode, JSON.stringify(r.state.body)).toBe(201);
  });
});

describe('admin company delete with a mark present', () => {
  it('succeeds (soft delete); the marks stay with the company row', async () => {
    expect((await marks()).length).toBeGreaterThan(0);
    expect(await deleteCompany(fx.company)).toBe(true);
    expect((await pool.query('SELECT status FROM companies WHERE id = $1', [fx.company])).rows[0].status).toBe('deleted');
    expect((await marks()).length).toBeGreaterThan(0);
  });
});
