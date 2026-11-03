/**
 * Budgets P5 T10 (spec §4 variance-notes row), the routes called as real members through withAuth's
 * request transaction (app_user, forced RLS, CSRF): GET/POST /api/accounting/budgets/variance-notes, and
 * the generic commentary approve/reject routes, which act on a row by id and must not reach a variance
 * note (census T1.3: they would bypass the variance approver rule — the reject route admits a manager).
 * Seed: helpers/budgetTrackingFixture.ts (FY2027 primary 'Original'); members added per role.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import notesRoute from '../../pages/api/accounting/budgets/variance-notes';
import commentaryApprove from '../../pages/api/accounting/commentary/[id]/approve';
import commentaryReject from '../../pages/api/accounting/commentary/[id]/reject';
import { varianceParamsHash } from '@/modules/accounting/services/reports/varianceParamsHash';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';
import { dropTrackingFixture, seedTrackingFixture, type TrackingFixture } from './helpers/budgetTrackingFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let f: TrackingFixture;
type Member = { userId: string; token: string };
const m = {} as Record<'owner' | 'manager' | 'viewer', Member>;
const MONTH = '2026-06';

beforeAll(async () => {
  f = await seedTrackingFixture(pool);
  for (const role of ['owner', 'manager', 'viewer'] as const) {
    const userId = crypto.randomUUID();
    await pool.query(`INSERT INTO users (id, email, role, is_active, onboarding_completed) VALUES ($1, $2, 'admin', true, true)`, [userId, `${userId}@test.local`]);
    await pool.query('INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, $3, true)', [f.a, userId, role]);
    m[role] = { userId, token: await signSession(userId, undefined, 'aal2') };
  }
}, 120_000);
afterAll(async () => {
  const ids = Object.values(m).map((x) => x.userId);
  try {
    await pool.query('DELETE FROM report_commentary WHERE company_id = ANY($1::UUID[])', [[f.a, f.b]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key LIKE 'variance-notes-%' AND split_part(key, ':', 2) = ANY($1::TEXT[])", [ids]);
    await pool.query('DELETE FROM company_users WHERE user_id = ANY($1::TEXT[])', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [ids]);
    await dropTrackingFixture(pool, f);
  } finally { await pool.end(); }
});

type Out = { status: number; body: { data?: Record<string, unknown> & { note?: { id: string; status: string }; notes?: Array<Record<string, unknown>> } } };
async function call(route: unknown, who: Member, method: string, body?: unknown, query: Record<string, string> = {}, csrf = true): Promise<Out> {
  const req = request({ 'sb-access-token': who.token, active_company_id: f.a }, method) as unknown as
    { url: string; query: Record<string, string>; body: unknown; headers: Record<string, string> };
  req.url = '/api/accounting/budgets/variance-notes';
  req.query = query;
  req.body = body;
  if (!csrf) delete req.headers['x-csrf-token'];
  const out = response();
  await (route as (a: never, b: never) => Promise<unknown>)(req as never, out.res as never);
  return { status: out.state.statusCode, body: (out.state.body ?? {}) as Out['body'] };
}
const save = (who: Member, text: string, over: Record<string, unknown> = {}) => call(notesRoute, who, 'POST', {
  action: 'save', versionId: f.v.primary27, month: MONTH, glAccountId: f.acc.opex, cc1Id: null, cc2Id: null, buId: null, text, ...over,
});
const list = (who: Member, versionId = f.v.primary27) => call(notesRoute, who, 'GET', undefined, { versionId, month: MONTH });
const statusOf = async (id: string) => String((await pool.query('SELECT status FROM report_commentary WHERE id = $1', [id])).rows[0]?.status);

describe('variance-notes route: roles', () => {
  it('manager saves a draft a viewer cannot see; manager approve is 403; owner approves; the viewer then reads the approved text only', async () => {
    const saved = await save(m.manager, 'Rent rose with the new lease.');
    expect(saved.status).toBe(200);
    const id = saved.body.data!.note!.id;
    expect((await list(m.viewer)).body.data!.notes).toEqual([]);
    expect((await list(m.manager)).body.data!.notes).toEqual([expect.objectContaining({ id, status: 'draft', draftText: 'Rent rose with the new lease.' })]);

    expect((await call(notesRoute, m.manager, 'POST', { action: 'approve', id, draft: 'Rent rose with the new lease.' })).status).toBe(403);
    expect((await call(notesRoute, m.manager, 'POST', { action: 'reject', id })).status).toBe(403);
    expect(await statusOf(id)).toBe('draft');
    const approved = await call(notesRoute, m.owner, 'POST', { action: 'approve', id, draft: 'Rent rose with the new lease.', text: 'Rent rose: new lease from June.' });
    expect(approved.status).toBe(200);
    expect(approved.body.data!.note).toMatchObject({ status: 'approved', approvedText: 'Rent rose: new lease from June.' });
    expect((await list(m.viewer)).body.data!.notes).toEqual([
      expect.objectContaining({ id, status: 'approved', approvedText: 'Rent rose: new lease from June.', draftText: null })]);
  });

  it('a viewer cannot write (403); a POST without the CSRF header is refused; an unknown action or a bad id is a 422 (zod)', async () => {
    expect((await save(m.viewer, 'x')).status).toBe(403);
    expect((await call(notesRoute, m.owner, 'POST', { action: 'save' }, {}, false)).status).toBe(403);
    expect((await call(notesRoute, m.owner, 'POST', { action: 'publish', id: crypto.randomUUID() })).status).toBe(422);
    expect((await call(notesRoute, m.owner, 'POST', { action: 'approve', id: 'not-a-uuid', draft: 'x' })).status).toBe(422);
    expect((await call(notesRoute, m.owner, 'PUT', {})).status).toBe(405);
  });
});

describe('variance-notes route: the approver signs what they were shown', () => {
  it('a draft changed since the approver loaded it answers 409 and stays a draft; an approve without the shown draft is a 422', async () => {
    const saved = await save(m.manager, 'Seen by the owner.', { glAccountId: f.acc.cos, cc1Id: f.cc.FT });
    const id = saved.body.data!.note!.id;
    expect((await save(m.manager, 'Changed afterwards.', { glAccountId: f.acc.cos, cc1Id: f.cc.FT })).status).toBe(200);
    expect((await call(notesRoute, m.owner, 'POST', { action: 'approve', id, draft: 'Seen by the owner.' })).status).toBe(409);
    expect((await call(notesRoute, m.owner, 'POST', { action: 'approve', id })).status).toBe(422);
    expect(await statusOf(id)).toBe('draft');
  });
});

describe('variance-notes route: company scoping', () => {
  it('another company\'s version, account, centre or note id answers 404 and writes nothing', async () => {
    const theirs = crypto.randomUUID();
    await pool.query(`INSERT INTO report_commentary (id, company_id, report_kind, params_hash, period_start, period_end, section_ref, row_ref,
      draft_text, generated_by) VALUES ($1, $2, 'budget_variance', $3, '2026-06-01', '2026-06-30', 'account', $4, 'B SECRET', 'u')`,
    [theirs, f.b, varianceParamsHash(f.v.b27, MONTH), `${f.acc.bSales}|||`]);
    expect((await save(m.owner, 'x', { versionId: f.v.b27 })).status).toBe(404);
    expect((await save(m.owner, 'x', { glAccountId: f.acc.bSales })).status).toBe(404);
    expect((await save(m.owner, 'x', { cc1Id: f.cc.BX })).status).toBe(404);
    expect((await list(m.owner, f.v.b27)).status).toBe(404);
    expect((await call(notesRoute, m.owner, 'POST', { action: 'approve', id: theirs, draft: 'B SECRET' })).status).toBe(404);
    expect((await call(notesRoute, m.owner, 'POST', { action: 'reject', id: theirs })).status).toBe(404);
    expect(await statusOf(theirs)).toBe('draft');
    expect((await pool.query("SELECT COUNT(*)::INT n FROM report_commentary WHERE company_id = $1 AND draft_text = 'x'", [f.a])).rows[0].n).toBe(0);
  });
});

describe('the generic commentary routes refuse a variance note (census T1.3)', () => {
  it('approve as owner and reject as manager both answer 404; the note stays a draft', async () => {
    const saved = await save(m.manager, 'Not for the pack routes.', { glAccountId: f.acc.sales, cc2Id: f.cc.P1 });
    const id = saved.body.data!.note!.id;
    const approve = await call(commentaryApprove, m.owner, 'POST', undefined, { id });
    const reject = await call(commentaryReject, m.manager, 'POST', undefined, { id });
    expect([approve.status, reject.status]).toEqual([404, 404]);
    expect(await statusOf(id)).toBe('draft');
  });
});
