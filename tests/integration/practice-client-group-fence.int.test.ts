// tests/integration/practice-client-group-fence.int.test.ts
//
// R-161. The practice client POST and PUT stored the body's `clientGroupId` in
// `practice_clients.client_group_id` with no read of `practice_client_groups`.
// The FK is tenant-agnostic and the RLS WITH CHECK only tests the CLIENT's own
// company_id, so company A could file its client under company B's group.
//
// R-163. The rate-overrides route's own client check read `practice_clients`
// with no savepoint, so a malformed client id (22P02) aborted the request
// transaction and answered 500 instead of 400.
//
// Driven through the real handlers — `withAuth` (app_user + GUCs), CSRF and
// write-access — because the refusal must be a 4xx, not a 500, and must come
// BEFORE the first write (`withAuth` COMMITs a 4xx returned after one). The
// fixture rows are built by the owner role: forced RLS hides B's rows from
// app_user. Each refusal is paired with the same call naming A's own row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { als } from '../../src/lib/als';
import clients from '../../pages/api/accounting/practice/clients';
import clientById from '../../pages/api/accounting/practice/clients/[id]';
import rateOverrides from '../../pages/api/accounting/practice/clients/[id]/rate-overrides';
import {
  assertClientGroupInCompany,
  ClientGroupNotInCompanyError,
} from '@/modules/accounting/services/practice/practiceClientFence';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const USER = randomUUID();
const GROUP_A = randomUUID();
const GROUP_A2 = randomUUID();
const GROUP_B = randomUUID();
const CLIENT_A = randomUUID();
const CLIENT_B = randomUUID();

type Handler = (req: never, res: never) => Promise<unknown> | unknown;

describeIfDb('R-161 / R-163 — practice client group and rate-override fences', () => {
  let pool: Pool;
  let token = '';

  const count = async (text: string, params: unknown[]): Promise<number> =>
    Number((await pool.query(text, params)).rows[0].n);
  const clientsNamed = (name: string) =>
    count('SELECT count(*) AS n FROM practice_clients WHERE company_id = $1 AND legal_name = $2', [A, name]);
  const groupOf = async (clientId: string): Promise<string | null> =>
    (await pool.query('SELECT client_group_id FROM practice_clients WHERE id = $1', [clientId])).rows[0]
      .client_group_id as string | null;
  const overridesOf = (companyId: string) =>
    count('SELECT count(*) AS n FROM practice_client_rate_overrides WHERE company_id = $1', [companyId]);

  async function call(handler: Handler, method: string, body: Record<string, unknown>, id?: string) {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method, id) as never as
      { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/practice/r161-fence-fixture';
    const out = response();
    await handler(req as never, out.res as never);
    return out.state;
  }

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
      [A, 'R161 Co A', B, 'R161 Co B']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `r161-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    await pool.query(
      `INSERT INTO practice_client_groups (id, company_id, name) VALUES ($1, $2, 'R161 Group A'),
         ($3, $2, 'R161 Group A2'), ($4, $5, 'R161 Group B (secret)')`,
      [GROUP_A, A, GROUP_A2, GROUP_B, B]);
    await pool.query(
      `INSERT INTO practice_clients (id, company_id, legal_name, client_group_id) VALUES ($1, $2, 'R161 Client A', $3),
         ($4, $5, 'R161 Client B (secret)', NULL)`,
      [CLIENT_A, A, GROUP_A, CLIENT_B, B]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['practice_client_rate_overrides', 'practice_clients', 'practice_client_groups',
        'practice_job_categories', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
      }
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  describe('clients POST (R-161)', () => {
    const base = { billingModel: 'hourly', status: 'active' };

    it('refuses company B\'s client group with a 400 and stores no client', async () => {
      const state = await call(clients, 'POST', { ...base, legalName: 'R161 planted', clientGroupId: GROUP_B });
      expect(state.statusCode).toBe(400);
      expect(await clientsNamed('R161 planted')).toBe(0);
    });

    it('still stores a client in company A\'s own group', async () => {
      const state = await call(clients, 'POST', { ...base, legalName: 'R161 own group', clientGroupId: GROUP_A2 });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
      expect((await pool.query('SELECT client_group_id FROM practice_clients WHERE company_id = $1 AND legal_name = $2',
        [A, 'R161 own group'])).rows[0].client_group_id).toBe(GROUP_A2);
    });

    it('still stores a client with no group, as before', async () => {
      const state = await call(clients, 'POST', { ...base, legalName: 'R161 no group' });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
      expect(await count(
        'SELECT count(*) AS n FROM practice_clients WHERE company_id = $1 AND legal_name = $2 AND client_group_id IS NULL',
        [A, 'R161 no group'])).toBe(1);
    });

    it('refuses a malformed group id with a 400, not a 500, and stores no client', async () => {
      const state = await call(clients, 'POST', { ...base, legalName: 'R161 bad group', clientGroupId: 'not-a-uuid' });
      expect(state.statusCode).toBe(400);
      expect(await clientsNamed('R161 bad group')).toBe(0);
    });
  });

  describe('clients/[id] PUT (R-161)', () => {
    it('refuses moving A\'s client into company B\'s group, and it keeps its own', async () => {
      const state = await call(clientById, 'PUT', { clientGroupId: GROUP_B }, CLIENT_A);
      expect(state.statusCode).toBe(400);
      expect(await groupOf(CLIENT_A)).toBe(GROUP_A);
    });

    it('refuses a malformed group id with a 400, not a 500', async () => {
      const state = await call(clientById, 'PUT', { clientGroupId: 'not-a-uuid' }, CLIENT_A);
      expect(state.statusCode).toBe(400);
      expect(await groupOf(CLIENT_A)).toBe(GROUP_A);
    });

    it('still moves A\'s client into another of A\'s own groups', async () => {
      const state = await call(clientById, 'PUT', { clientGroupId: GROUP_A2 }, CLIENT_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      expect(await groupOf(CLIENT_A)).toBe(GROUP_A2);
    });

    it('an update naming no group leaves the group as it was', async () => {
      const state = await call(clientById, 'PUT', { tradingName: 'R161 renamed' }, CLIENT_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      expect(await groupOf(CLIENT_A)).toBe(GROUP_A2);
    });
  });

  describe('clients/[id]/rate-overrides (R-163)', () => {
    it('answers a malformed client id with a 400, not a 500', async () => {
      const state = await call(rateOverrides, 'GET', {}, 'not-a-uuid');
      expect(state.statusCode).toBe(400);
    });

    it('refuses a malformed client id on POST with a 400 and writes nothing', async () => {
      const before = await overridesOf(A);
      const state = await call(rateOverrides, 'POST',
        { staffUserId: USER, ratePerHour: 500, effectiveFrom: '2027-01-01' }, 'not-a-uuid');
      expect(state.statusCode).toBe(400);
      expect(await overridesOf(A)).toBe(before);
    });

    it('still answers company B\'s client with a 404 and writes nothing', async () => {
      expect((await call(rateOverrides, 'GET', {}, CLIENT_B)).statusCode).toBe(404);
      const state = await call(rateOverrides, 'POST',
        { staffUserId: USER, ratePerHour: 500, effectiveFrom: '2027-01-01' }, CLIENT_B);
      expect(state.statusCode).toBe(404);
      expect(await overridesOf(A)).toBe(0);
      expect(await overridesOf(B)).toBe(0);
    });

    it('still lists and creates overrides on A\'s own client', async () => {
      const created = await call(rateOverrides, 'POST',
        { staffUserId: USER, ratePerHour: 650, effectiveFrom: '2027-01-01' }, CLIENT_A);
      expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
      const listed = await call(rateOverrides, 'GET', {}, CLIENT_A);
      expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
      expect((listed.body as { data: unknown[] }).data).toHaveLength(1);
    });
  });

  // Through withAuth, forced RLS already hides B's group from app_user, so the
  // routes above would refuse it even without the fence's company predicate.
  // Called on the owner connection (as a script or any non-withAuth caller
  // runs), only that predicate stands between B's group and a write.
  describe('the group fence itself, outside RLS', () => {
    it('refuses company B\'s group and passes A\'s own and an absent id', async () => {
      await expect(assertClientGroupInCompany(A, GROUP_B)).rejects.toBeInstanceOf(ClientGroupNotInCompanyError);
      await expect(assertClientGroupInCompany(A, GROUP_A)).resolves.toBeUndefined();
      await expect(assertClientGroupInCompany(A, null)).resolves.toBeUndefined();
    });
  });

  // Inside a request transaction (as withAuth runs it) a 22P02 would abort the
  // whole transaction; the savepoint is what keeps the next read usable. The
  // routes above cannot show this: they answer 400 straight after the refusal.
  describe('the group fence inside a request transaction', () => {
    it('refuses a malformed id inside a request transaction and leaves it usable', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await als.run({ client, userId: USER, companyId: A, claims: {} }, async () => {
          await expect(assertClientGroupInCompany(A, 'not-a-uuid')).rejects.toBeInstanceOf(ClientGroupNotInCompanyError);
          await expect(assertClientGroupInCompany(A, GROUP_A)).resolves.toBeUndefined();
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
