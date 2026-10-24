// tests/integration/bureau-consent-links.int.test.ts
//
// Migration 932: bureaus had no row security and app_user held every write on
// bureaus, bureau_users and bureau_companies. SQL injected on either app pool
// (forged request.jwt.claims) could switch any bureau's merchant-sharing
// consent on, link a company to a sharing bureau, unlink it from the bureau
// that keeps it out of the pool, join a bureau (and so read its clients), and
// read any bureau. Each must now be refused by privilege on the logins
// production has (s07b helpers); the bureau rows are readable only by their
// owner and members inside a request. The legitimate paths run on the
// migration_admin pool through the real routes: below, second describe.
// The migration and its every-deploy rules: bureau-consent-links.migration.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Pool } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import clientsRoute from '../../pages/api/bureau/clients';
import settingsRoute from '../../pages/api/bureau/settings';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { attempt, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
// me: admin of `company`; owner: owner of `company`; invitee: a member of nothing (the attacker).
const { me, owner, admin, invitee, company, other } = ids;
const mine = crypto.randomUUID(); // owned by me; not sharing
const sharing = crypto.randomUUID(); // owned by admin; sharing on
const keeper = crypto.randomUUID(); // owned by owner; not sharing; `company` is linked to it and to `sharing`
const outside = crypto.randomUUID(); // owned by accountant, who is not in `company`; `company` is linked to it
const accountant = crypto.randomUUID();
const companyViewer = crypto.randomUUID(); // a viewer of `company`
const third = crypto.randomUUID(); // a company linked to `sharing`, which its bureau owner (admin) is not in
// The pool's key shape: one or two A-Z words.
const merchant = `BUREAU ${crypto.randomUUID().replace(/[^a-f]/g, '').toUpperCase().padEnd(12, 'Q').slice(0, 12)}`;

beforeAll(async () => {
  await setup(ids);
  await fixture.query(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active'),
    ($3, $4, 'viewer', true, 'active')`, [accountant, `${accountant}@test.local`, companyViewer, `${companyViewer}@test.local`]);
  await fixture.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [company, companyViewer]);
  await fixture.query(`INSERT INTO companies (id, name, is_active) VALUES ($1, '932 third', true)`, [third]);
  await fixture.query(`INSERT INTO bureaus (id, name, owner_user_id, share_merchant_patterns) VALUES
    ($1, '932 mine', $2, false), ($3, '932 sharing', $4, true), ($5, '932 keeper', $6, false), ($7, '932 outside', $8, false)`,
  [mine, me, sharing, admin, keeper, owner, outside, accountant]);
  await fixture.query(`INSERT INTO bureau_users (bureau_id, user_id, role) VALUES
    ($1, $2, 'owner'), ($3, $4, 'owner'), ($5, $6, 'owner'), ($1, $7, 'accountant')`,
  [mine, me, sharing, admin, keeper, owner, accountant]);
  await fixture.query('INSERT INTO bureau_companies (bureau_id, company_id) VALUES ($1, $2), ($3, $2), ($4, $2)',
    [sharing, company, keeper, outside]);
  await fixture.query('INSERT INTO bureau_companies (bureau_id, company_id) VALUES ($1, $2)', [sharing, third]);
  await fixture.query(`INSERT INTO shared_merchant_patterns (normalized_merchant, category_code, distinct_company_count,
    agreement_pct, total_observations, filter_version) SELECT $1, code, 5, 0.9, 20, 1 FROM merchant_categories WHERE poolable LIMIT 1`, [merchant]);
}, 60000);

afterAll(async () => {
  await fixture.query('DELETE FROM shared_merchant_patterns WHERE normalized_merchant = $1', [merchant]);
  await fixture.query('DELETE FROM bureaus WHERE id = ANY($1::uuid[])', [[mine, sharing, keeper, outside]]);
  await fixture.query('DELETE FROM companies WHERE id = $1', [third]);
  await fixture.query('DELETE FROM company_users WHERE user_id = $1', [companyViewer]);
  await fixture.query('DELETE FROM users WHERE id = ANY($1::text[])', [[accountant, companyViewer]]);
  vi.unstubAllEnvs();
  await teardown(ids, [getAuthPool(), getDbPool()]);
});

const denied = (table: string) => ({ code: '42501', message: `permission denied for table ${table}` });

/** [what it would do, table, statement, params] */
type Attack = [string, string, string, () => unknown[]];
const WRITES: Attack[] = [
  ['switch on another bureau\'s consent', 'bureaus', 'UPDATE bureaus SET share_merchant_patterns = true WHERE id = $1', () => [keeper]],
  ['take over a bureau', 'bureaus', 'UPDATE bureaus SET owner_user_id = $2 WHERE id = $1', () => [keeper, invitee]],
  ['create a bureau in someone else\'s name', 'bureaus', `INSERT INTO bureaus (name, owner_user_id, share_merchant_patterns)
    VALUES ('forged', $1, true)`, () => [owner]],
  ['delete a bureau (and its clients\' links)', 'bureaus', 'DELETE FROM bureaus WHERE id = $1', () => [keeper]],
  ['join a bureau, and so read its clients', 'bureau_users', `INSERT INTO bureau_users (bureau_id, user_id, role)
    VALUES ($1, $2, 'accountant')`, () => [keeper, invitee]],
  ['become a bureau\'s member by moving a membership', 'bureau_users', 'UPDATE bureau_users SET user_id = $2 WHERE bureau_id = $1',
    () => [mine, invitee]],
  ['link a company to a sharing bureau', 'bureau_companies', 'INSERT INTO bureau_companies (bureau_id, company_id) VALUES ($1, $2)',
    () => [sharing, other]],
  ['unlink a company from the non-sharing bureau that keeps it out', 'bureau_companies',
    'DELETE FROM bureau_companies WHERE bureau_id = $1 AND company_id = $2', () => [keeper, company]],
  ['re-point a link at a sharing bureau', 'bureau_companies', 'UPDATE bureau_companies SET bureau_id = $1 WHERE bureau_id = $2',
    () => [sharing, keeper]],
];

const pools: Array<[string, () => Pool, Parameters<typeof attempt>[2]]> = [
  ['isaflow_app under the company owner\'s forged claims', getAuthPool, { asRequest: { sub: owner, companyId: company } }],
  ['isaflow_app under the bureau owner\'s forged claims', getAuthPool, { asRequest: { sub: admin, companyId: company } }],
  ['isaflow_service with no claims', getDbPool, {}],
  ['isaflow_service under the bureau owner\'s forged claims', getDbPool, { claims: { sub: owner, companyId: company } }],
];

describe.each(pools)('932: %s', (_, pool, opts) => {
  it.each(WRITES)('cannot %s', async (_what, table, text, params) => {
    expect(await attempt(pool(), [[text, params()]], opts)).toEqual(denied(table));
  });

  it.each(WRITES.filter(([, t], i) => WRITES.findIndex(([, u]) => u === t) === i))(
    'cannot %s after set_config(role, none) either', async (_what, table, text, params) => {
      expect(await attempt(pool(), [[`SELECT set_config('role', 'none', true)`], [text, params()]], opts)).toEqual(denied(table));
    });
});

describe('932: reads', () => {
  const seen = async (sub: string): Promise<string[]> => {
    const c = await getAuthPool().connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]);
      const r = await c.query<{ name: string }>('SELECT name FROM bureaus WHERE id = ANY($1::uuid[]) ORDER BY name',
        [[mine, sharing, keeper, outside]]);
      return r.rows.map((x) => x.name);
    } finally {
      await c.query('ROLLBACK');
      c.release(true);
    }
  };

  it('in a request, a user reads only the bureaus they own or are a member of', async () => {
    expect(await seen(invitee)).toEqual([]);
    expect(await seen(me)).toEqual(['932 mine']);
    expect(await seen(accountant)).toEqual(['932 mine', '932 outside']);
    // owner owns `company`, which is linked to `sharing`: a linked company does not read the bureau row.
    expect(await seen(owner)).toEqual(['932 keeper']);
  });

  it('in a request, a member reads only their own bureau_users rows', async () => {
    const c = await getAuthPool().connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: accountant })]);
      const r = await c.query('SELECT user_id FROM bureau_users WHERE bureau_id = $1', [mine]);
      expect(r.rows).toEqual([{ user_id: accountant }]);
    } finally {
      await c.query('ROLLBACK');
      c.release(true);
    }
  });

  it('the bureau audit log stays unreadable to both app pools', async () => {
    expect(await attempt(getAuthPool(), [['SELECT 1 FROM bureau_audit_log']], { asRequest: { sub: me, companyId: company } }))
      .toEqual(denied('bureau_audit_log'));
    expect(await attempt(getDbPool(), [['SELECT 1 FROM bureau_audit_log']])).toEqual(denied('bureau_audit_log'));
  });
});

describe('932: the breaker\'s repro (shared_pool_lookup 0 -> 1) stays at 0', () => {
  it('a member of a linked company cannot switch its non-sharing bureaus on, so the pool still answers nothing', async () => {
    vi.stubEnv('MERCHANT_SHARING_ENABLED', 'true');
    const c = await getAuthPool().connect();
    const outcome: { refused: string | null; matches: number } = { refused: null, matches: -1 };
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: owner })]);
      await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [company]);
      await c.query('SAVEPOINT flip');
      try {
        await c.query('UPDATE bureaus SET share_merchant_patterns = true WHERE id = ANY($1::uuid[])', [[keeper, outside]]);
      } catch (err) {
        outcome.refused = (err as { code?: string }).code ?? 'none';
        await c.query('ROLLBACK TO SAVEPOINT flip');
      }
      const r = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM shared_pool_lookup($1::uuid, ARRAY[$2::text])',
        [company, merchant]);
      outcome.matches = r.rows[0]!.n;
    } finally {
      await c.query('ROLLBACK');
      c.release(true);
      vi.stubEnv('MERCHANT_SHARING_ENABLED', '');
    }
    expect(outcome).toEqual({ refused: '42501', matches: 0 });
  });
});

describe('932: the legitimate paths, through the real routes on the production logins', () => {
  const audit = async (bureauId: string) => (await fixture.query(
    'SELECT actor_user_id, old_value, new_value FROM bureau_audit_log WHERE bureau_id = $1 ORDER BY created_at, id', [bureauId])).rows;
  const linked = async (bureauId: string, companyId: string) => (await fixture.query(
    'SELECT 1 FROM bureau_companies WHERE bureau_id = $1 AND company_id = $2', [bureauId, companyId])).rowCount === 1;

  it('the owner switches sharing on and off, and each change is audited; GET shows the history', async () => {
    vi.stubEnv('MERCHANT_SHARING_ENABLED', 'true');
    try {
      const on = await callRoute(settingsRoute, { sub: me, method: 'PUT', body: { bureauId: mine, shareMerchantPatterns: true } });
      expect(on).toMatchObject({ status: 200, body: { data: { shareMerchantPatterns: true, changed: true } } });
      const off = await callRoute(settingsRoute, { sub: me, method: 'PUT', body: { bureauId: mine, shareMerchantPatterns: false } });
      expect(off).toMatchObject({ status: 200, body: { data: { shareMerchantPatterns: false, changed: true } } });
    } finally {
      vi.stubEnv('MERCHANT_SHARING_ENABLED', '');
    }
    expect(await audit(mine)).toEqual([
      { actor_user_id: me, old_value: false, new_value: true },
      { actor_user_id: me, old_value: true, new_value: false },
    ]);
    const get = await callRoute(settingsRoute, { sub: accountant, method: 'GET', query: { bureauId: mine } });
    expect(get.status).toBe(200);
    expect((get.body as { data: { history: unknown[]; canEdit: boolean } }).data).toMatchObject({ canEdit: false });
    expect((get.body as { data: { history: unknown[] } }).data.history).toHaveLength(2);
  });

  it('with the gate off, switching on is the documented 409 and writes nothing', async () => {
    const r = await callRoute(settingsRoute, { sub: me, method: 'PUT', body: { bureauId: mine, shareMerchantPatterns: true } });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('sharing_pending_legal_review');
    expect(await audit(mine)).toHaveLength(2);
  });

  it('a member who is not the owner cannot toggle', async () => {
    const r = await callRoute(settingsRoute, { sub: accountant, method: 'PUT', body: { bureauId: mine, shareMerchantPatterns: false } });
    expect(r.status).toBe(403);
  });

  it('the bureau owner who is the company\'s admin links it; the bureau owner unlinks it', async () => {
    const link = await callRoute(clientsRoute, { sub: me, method: 'POST', body: { bureauId: mine, companyId: company } });
    expect(link).toMatchObject({ status: 200, body: { data: { linked: true } } });
    expect(await linked(mine, company)).toBe(true);
    const unlink = await callRoute(clientsRoute, { sub: me, method: 'DELETE', body: { bureauId: mine, companyId: company } });
    expect(unlink).toMatchObject({ status: 200, body: { data: { unlinked: true } } });
    expect(await linked(mine, company)).toBe(false);
  });

  it('the bureau owner unlinks a company they are not a member of', async () => {
    const r = await callRoute(clientsRoute, { sub: admin, method: 'DELETE', body: { bureauId: sharing, companyId: third } });
    expect(r).toMatchObject({ status: 200, body: { data: { unlinked: true } } });
    expect(await linked(sharing, third)).toBe(false);
  });

  it('a bureau owner who does not manage the company cannot link it', async () => {
    const r = await callRoute(clientsRoute, { sub: admin, method: 'POST', body: { bureauId: sharing, companyId: other } });
    expect(r.status).toBe(403);
    expect(await linked(sharing, other)).toBe(false);
  });

  it('the company\'s admin unlinks it from a bureau they are not in; a stranger or a company viewer cannot', async () => {
    const stranger = await callRoute(clientsRoute, { sub: invitee, method: 'DELETE', body: { bureauId: sharing, companyId: company } });
    expect(stranger.status).toBe(403);
    expect(await linked(sharing, company)).toBe(true);
    const accountantOfOther = await callRoute(clientsRoute, { sub: accountant, method: 'DELETE',
      body: { bureauId: sharing, companyId: company } });
    expect(accountantOfOther.status).toBe(403);
    const viewer = await callRoute(clientsRoute, { sub: companyViewer, method: 'DELETE', body: { bureauId: sharing, companyId: company } });
    expect(viewer.status).toBe(403);
    expect(await linked(sharing, company)).toBe(true);
    const r = await callRoute(clientsRoute, { sub: me, method: 'DELETE', body: { bureauId: sharing, companyId: company } });
    expect(r).toMatchObject({ status: 200, body: { data: { unlinked: true } } });
    expect(await linked(sharing, company)).toBe(false);
  });

  it('the company\'s owner unlinks it from a bureau they are not in', async () => {
    const r = await callRoute(clientsRoute, { sub: owner, method: 'DELETE', body: { bureauId: outside, companyId: company } });
    expect(r).toMatchObject({ status: 200, body: { data: { unlinked: true } } });
    expect(await linked(outside, company)).toBe(false);
  });
});
