// tests/integration/r170-practice-client-empty-ids.int.test.ts
//
// R-170. An empty string for `clientGroupId` or `linkCustomerId` passed the
// practice client fences (`assertClientGroupInCompany` / `assertCustomerInCompany`
// treat a falsy id as absent) and then reached the `::UUID` cast on the write
// itself, which is not savepointed — 22P02 aborted the request transaction
// and the route answered 500. A malformed route id on `clients/[id]` (GET,
// PUT, DELETE) hit the same uncaught cast in the initial existence read.
//
// Decision (Hein, 2026-09-30): `''` means "none" — on create it stores NULL;
// on update it CLEARS the field. Update must still distinguish "field absent"
// (leave unchanged) from `''`/null (clear).
//
// Driven through the real handlers — `withAuth` (app_user + GUCs), CSRF and
// write-access.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import clients from '../../pages/api/accounting/practice/clients';
import clientById from '../../pages/api/accounting/practice/clients/[id]';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const USER = randomUUID();
const GROUP_A = randomUUID();
const GROUP_B = randomUUID();
const CUSTOMER_A = randomUUID();
const CUSTOMER_B = randomUUID();
const CLIENT_A = randomUUID();

type Handler = (req: never, res: never) => Promise<unknown> | unknown;

describeIfDb('R-170 — practice client empty/malformed id handling', () => {
  let pool: Pool;
  let token = '';

  const clientRow = async (id: string): Promise<{ client_group_id: string | null; link_customer_id: string | null }> => {
    const rows = (await pool.query('SELECT client_group_id, link_customer_id FROM practice_clients WHERE id = $1', [id])).rows;
    return rows[0];
  };
  const clientsNamed = async (name: string) =>
    Number((await pool.query('SELECT count(*) AS n FROM practice_clients WHERE company_id = $1 AND legal_name = $2',
      [A, name])).rows[0].n);

  async function call(handler: Handler, method: string, body: Record<string, unknown>, id?: string) {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method, id) as never as
      { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/practice/r170-fixture';
    const out = response();
    await handler(req as never, out.res as never);
    return out.state;
  }

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
      [A, 'R170 Co A', B, 'R170 Co B']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `r170-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    await pool.query(
      `INSERT INTO practice_client_groups (id, company_id, name) VALUES ($1, $2, 'R170 Group A'), ($3, $4, 'R170 Group B')`,
      [GROUP_A, A, GROUP_B, B]);
    await pool.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'R170 Customer A'), ($3, $4, 'R170 Customer B')`,
      [CUSTOMER_A, A, CUSTOMER_B, B]);
    await pool.query(
      `INSERT INTO practice_clients (id, company_id, legal_name, client_group_id, link_customer_id)
       VALUES ($1, $2, 'R170 Client A', $3, $4)`,
      [CLIENT_A, A, GROUP_A, CUSTOMER_A]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['practice_clients', 'practice_client_groups', 'customers', 'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
      }
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  describe('clients POST — empty string means "none"', () => {
    const base = { billingModel: 'hourly', status: 'active' };

    it('stores NULL for an empty clientGroupId, not a 500', async () => {
      const state = await call(clients, 'POST', { ...base, legalName: 'R170 empty group', clientGroupId: '' });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
      expect(await clientsNamed('R170 empty group')).toBe(1);
    });

    it('stores NULL for an empty linkCustomerId, not a 500', async () => {
      const state = await call(clients, 'POST', { ...base, legalName: 'R170 empty customer', linkCustomerId: '' });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
      expect(await clientsNamed('R170 empty customer')).toBe(1);
    });

    it('still refuses a malformed (non-empty) clientGroupId with 400', async () => {
      const state = await call(clients, 'POST', { ...base, legalName: 'R170 bad group', clientGroupId: 'not-a-uuid' });
      expect(state.statusCode).toBe(400);
      expect(await clientsNamed('R170 bad group')).toBe(0);
    });

    it('still refuses company B\'s group with a 400', async () => {
      const state = await call(clients, 'POST', { ...base, legalName: 'R170 foreign group', clientGroupId: GROUP_B });
      expect(state.statusCode).toBe(400);
      expect(await clientsNamed('R170 foreign group')).toBe(0);
    });
  });

  describe('clients/[id] PUT — empty string clears, absent leaves unchanged', () => {
    it('clears a previously set group with an empty clientGroupId, not a 500', async () => {
      const state = await call(clientById, 'PUT', { clientGroupId: '' }, CLIENT_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      expect((await clientRow(CLIENT_A)).client_group_id).toBeNull();
    });

    it('clears a previously set customer with an empty linkCustomerId, not a 500', async () => {
      await pool.query('UPDATE practice_clients SET link_customer_id = $1 WHERE id = $2', [CUSTOMER_A, CLIENT_A]);
      const state = await call(clientById, 'PUT', { linkCustomerId: '' }, CLIENT_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      expect((await clientRow(CLIENT_A)).link_customer_id).toBeNull();
    });

    it('leaves the group unchanged when the field is absent from the body', async () => {
      await pool.query('UPDATE practice_clients SET client_group_id = $1 WHERE id = $2', [GROUP_A, CLIENT_A]);
      const state = await call(clientById, 'PUT', { tradingName: 'R170 renamed' }, CLIENT_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      expect((await clientRow(CLIENT_A)).client_group_id).toBe(GROUP_A);
    });

    it('still sets a real own-company id when one is provided', async () => {
      const state = await call(clientById, 'PUT', { clientGroupId: GROUP_A, linkCustomerId: CUSTOMER_A }, CLIENT_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      const row = await clientRow(CLIENT_A);
      expect(row.client_group_id).toBe(GROUP_A);
      expect(row.link_customer_id).toBe(CUSTOMER_A);
    });

    it('still refuses a malformed clientGroupId with 400', async () => {
      const state = await call(clientById, 'PUT', { clientGroupId: 'not-a-uuid' }, CLIENT_A);
      expect(state.statusCode).toBe(400);
    });
  });

  describe('clients/[id] — malformed route id (GET/PUT/DELETE)', () => {
    it('GET answers 400, not 500, for a malformed id', async () => {
      const state = await call(clientById, 'GET', {}, 'not-a-uuid');
      expect(state.statusCode).toBe(400);
    });

    it('PUT answers 400, not 500, for a malformed id', async () => {
      const state = await call(clientById, 'PUT', { tradingName: 'x' }, 'not-a-uuid');
      expect(state.statusCode).toBe(400);
    });

    it('DELETE answers 400, not 500, for a malformed id', async () => {
      const state = await call(clientById, 'DELETE', {}, 'not-a-uuid');
      expect(state.statusCode).toBe(400);
    });

    it('GET still answers 404 for a well-formed id belonging to no company', async () => {
      const state = await call(clientById, 'GET', {}, randomUUID());
      expect(state.statusCode).toBe(404);
    });
  });
});
