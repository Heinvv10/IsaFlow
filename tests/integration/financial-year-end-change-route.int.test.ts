/**
 * The change-of-year-end route as a browser calls it (real withAuth, withRole,
 * withCsrf): owner/admin only, CSRF on writes, refusals are 409 with their list,
 * a GET writes nothing, and an apply through the route is recorded against the
 * requesting user. Disposable schema fixture only. All data synthetic.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import route from '../../pages/api/accounting/financial-year-end-change';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';
import { newSetupUser, type SetupUser } from './helpers/onboardingSetupFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const made: string[] = [];
const users: string[] = [];

afterAll(async () => {
  try {
    for (const id of made) {
      await pool.query('UPDATE fiscal_years SET change_id = NULL WHERE company_id = $1', [id]);
      await pool.query('DELETE FROM fiscal_periods WHERE company_id = $1', [id]);
    }
    for (const u of users) await pool.query('DELETE FROM company_users WHERE user_id = $1', [u]);
  } finally { await pool.end(); }
}, 60000);

type Out = { status: number; body: { data?: Record<string, unknown>; error?: { code?: string; message?: string; details?: { refusals?: string[] } } } };

async function call(u: SetupUser, method: string, body?: unknown, query: Record<string, string> = {}, csrf = true): Promise<Out> {
  const req = request({ 'sb-access-token': u.token, active_company_id: u.homeCompanyId }, method) as unknown as
    { url: string; query: Record<string, string>; body: unknown; headers: Record<string, string> };
  req.url = '/api/accounting/financial-year-end-change';
  req.query = query;
  req.body = body;
  if (!csrf) delete req.headers['x-csrf-token'];
  const out = response();
  await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: (out.state.body ?? {}) as Out['body'] };
}

/** An owner of a fresh January-December company with its 2026 year generated. */
async function owner(): Promise<SetupUser> {
  const u = await newSetupUser(pool);
  users.push(u.userId);
  made.push(u.homeCompanyId);
  await pool.query('UPDATE companies SET financial_year_start = 1 WHERE id = $1', [u.homeCompanyId]);
  await pool.query(`SELECT public.fiscal_periods_generate(public.fiscal_year_ensure($1, CURRENT_DATE))`, [u.homeCompanyId]);
  return u;
}

async function member(of: SetupUser, role: string): Promise<SetupUser> {
  const userId = crypto.randomUUID();
  users.push(userId);
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)`, [userId, `${userId}@test.local`]);
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, $3)`, [of.homeCompanyId, userId, role]);
  return { userId, homeCompanyId: of.homeCompanyId, token: await signSession(userId, undefined, 'aal2') };
}

const OK = { reason: 'Align with the holding company year end', cipcFiledConfirmed: true, sarsNotifiedConfirmed: true };
const changes = async (co: string) => Number((await pool.query('SELECT COUNT(*)::int AS n FROM fiscal_year_end_changes WHERE company_id = $1', [co])).rows[0].n);

describe('who may call it', () => {
  it('an accountant (not owner/admin) is refused on every method, and nothing is written', async () => {
    const o = await owner();
    const acc = await member(o, 'accountant');
    for (const [method, body] of [['GET', undefined], ['POST', { newYearEndMonth: 2, ...OK }], ['DELETE', { reason: 'undo please, it was wrong' }]] as const) {
      const r = await call(acc, method, body);
      expect(r.status, method).toBe(403);
    }
    expect(await changes(o.homeCompanyId)).toBe(0);
  });

  it('a write without the CSRF token is refused (403) and writes nothing', async () => {
    const o = await owner();
    const r = await call(o, 'POST', { newYearEndMonth: 2, ...OK }, {}, false);
    expect(r.status).toBe(403);
    expect(await changes(o.homeCompanyId)).toBe(0);
  });
});

describe('what it does for an owner', () => {
  it('GET previews and writes nothing; a refusal is 409 with its list; an apply is recorded against the caller', async () => {
    const o = await owner();
    const preview = await call(o, 'GET', undefined, { newYearEndMonth: '2' });
    expect(preview.status).toBe(200);
    expect((preview.body.data?.preview as { chosen?: { months?: number } })?.chosen?.months).toBeGreaterThan(0);
    expect(await changes(o.homeCompanyId)).toBe(0);

    const refused = await call(o, 'POST', { newYearEndMonth: 2, ...OK, sarsNotifiedConfirmed: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.details?.refusals?.join(' ')).toMatch(/SARS/);
    expect(await changes(o.homeCompanyId)).toBe(0);

    const applied = await call(o, 'POST', { newYearEndMonth: 2, ...OK });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const rec = (await pool.query('SELECT applied_by::text AS by, snapshot FROM fiscal_year_end_changes WHERE company_id = $1', [o.homeCompanyId])).rows;
    expect(rec).toHaveLength(1);
    expect(rec[0].by).toBe(o.userId);
    expect(Array.isArray(rec[0].snapshot.years) && rec[0].snapshot.years.length).toBeGreaterThan(0);
  });
});

describe('change records cannot be forged', () => {
  it('a record naming a year that is not the open transition year is refused, and the snapshot is always the database\'s', async () => {
    const o = await owner();
    const year = (await pool.query(`SELECT id, start_date::text s FROM fiscal_years WHERE company_id = $1`, [o.homeCompanyId])).rows[0];
    const bad = await pool.query(
      `INSERT INTO fiscal_year_end_changes (company_id, fiscal_year_id, from_start_month, to_start_month, transition_start, from_end_date, to_end_date,
         months, reason, cipc_filed_confirmed, sars_notified_confirmed, applied_by)
       VALUES ($1, $2, 1, 3, '2001-01-01', '2026-12-31', '2027-02-28', 14, 'forged history row', true, true, $3)`,
      [o.homeCompanyId, year.id, o.userId]).catch((e: Error) => e);
    expect(String(bad)).toMatch(/must name the company's open transition year/);
    await pool.query('BEGIN');
    try {
      const forged = (await pool.query(
        `INSERT INTO fiscal_year_end_changes (company_id, fiscal_year_id, from_start_month, to_start_month, transition_start, from_end_date, to_end_date,
           months, reason, cipc_filed_confirmed, sars_notified_confirmed, applied_by, snapshot)
         VALUES ($1, $2, 1, 3, $3, '2026-12-31', '2027-02-28', 14, 'forged snapshot row', true, true, $4, '{"years":[],"periods":[]}')
         RETURNING snapshot`, [o.homeCompanyId, year.id, year.s, o.userId])).rows[0];
      expect(forged.snapshot.years.map((y: { id: string }) => y.id)).toContain(year.id);
    } finally { await pool.query('ROLLBACK'); }
  });
});

describe('an owner cannot write history by hand either (app_user, raw SQL)', () => {
  async function asOwner(o: SetupUser, fn: (c: import('pg').PoolClient) => Promise<unknown>): Promise<unknown> {
    const client = await pool.connect();
    let err: unknown = null;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: o.userId })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [o.homeCompanyId]);
      await client.query('SET LOCAL ROLE app_user');
      await fn(client);
    } catch (e) { err = e; } finally { await client.query('ROLLBACK'); client.release(); }
    return err;
  }

  it('a record born reversed is refused', async () => {
    const o = await owner();
    const y = (await pool.query(`SELECT id, start_date::text s FROM fiscal_years WHERE company_id = $1`, [o.homeCompanyId])).rows[0];
    const err = await asOwner(o, (c) => c.query(
      `INSERT INTO fiscal_year_end_changes (company_id, fiscal_year_id, from_start_month, to_start_month, transition_start,
         from_end_date, to_end_date, months, reason, cipc_filed_confirmed, sars_notified_confirmed, applied_by, reversed_by, reversed_at)
       VALUES ($1, $2, 1, 3, $3, '2026-12-31', '2027-02-28', 14, 'forged history row', true, true, $4, $4, now())`,
      [o.homeCompanyId, y.id, y.s, o.userId]));
    expect(String(err)).toMatch(/recorded live/);
  });

  it('marking a live change reversed without undoing it is refused', async () => {
    const o = await owner();
    expect((await call(o, 'POST', { newYearEndMonth: 2, ...OK })).status).toBe(200);
    const err = await asOwner(o, (c) => c.query(
      `UPDATE fiscal_year_end_changes SET reversed_at = now(), reversed_by = $1, reversal_reason = 'not really' WHERE company_id = $2`,
      [o.userId, o.homeCompanyId]));
    expect(String(err)).toMatch(/only after the year end is restored/);
  });
});
