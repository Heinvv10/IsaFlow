// tests/integration/practice-client-ownership-fence.int.test.ts
//
// R-073. The practice client-contacts POST took `clientId` from the request
// body and INSERTed it into `practice_client_contacts.client_id` with no read
// of `practice_clients`. The FK is tenant-agnostic and the RLS WITH CHECK only
// tests the CONTACT's own company_id, so company A could hang a contact off
// company B's practice client. The census of every column that FKs
// `practice_clients` found the same shape on the job PUT and both entry-template
// writes; those are driven here too.
//
// Driven through the real handlers — `withAuth` (app_user + GUCs), CSRF and
// write-access — because the refusal must be a 4xx, not a 500, and must come
// BEFORE the first write (`withAuth` COMMITs a 4xx returned after one). The
// fixture rows are built by the owner role: forced RLS hides B's client from
// app_user, which is exactly why the route cannot see it is foreign without a
// fence. Each refusal is paired with the same call naming A's own client.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import clientContacts from '../../pages/api/accounting/practice/client-contacts';
import jobById from '../../pages/api/accounting/practice/jobs/[id]';
import entryTemplates from '../../pages/api/accounting/practice/entry-templates';
import entryTemplateById from '../../pages/api/accounting/practice/entry-templates/[id]';
import {
  assertPracticeClientInCompany,
  PracticeClientNotInCompanyError,
} from '@/modules/accounting/services/practice/practiceClientFence';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET
  && process.env.ISAFLOW_DISPOSABLE_AUTH_TEST === '1' ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const USER = randomUUID();
const CLIENT_A = randomUUID();
const CLIENT_A2 = randomUUID();
const CLIENT_B = randomUUID();
const JOB_A = randomUUID();
const TEMPLATE_A = randomUUID();

type Handler = (req: never, res: never) => Promise<unknown> | unknown;

describeIfDb('R-073 — a practice client id from the body must be this company\'s', () => {
  let pool: Pool;
  let token = '';

  const count = async (text: string, params: unknown[]): Promise<number> =>
    Number((await pool.query(text, params)).rows[0].n);
  const contactsOn = (clientId: string) =>
    count('SELECT count(*) AS n FROM practice_client_contacts WHERE company_id = $1 AND client_id = $2', [A, clientId]);

  async function call(handler: Handler, method: string, body: Record<string, unknown>, id?: string) {
    const req = request({ 'sb-access-token': token, active_company_id: A }, method, id) as never as
      { body: unknown; url: string };
    req.body = body;
    req.url = '/api/accounting/practice/r073-fence-fixture';
    const out = response();
    await handler(req as never, out.res as never);
    return out.state;
  }

  beforeAll(async () => {
    assertDisposable();
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
      [A, 'R073 Co A', B, 'R073 Co B']);
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
      [USER, `r073-${USER}@isaflow.test`]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
    await pool.query(
      `INSERT INTO practice_clients (id, company_id, legal_name) VALUES ($1, $2, 'R073 Client A'),
         ($3, $2, 'R073 Client A2'), ($4, $5, 'R073 Client B (secret)')`,
      [CLIENT_A, A, CLIENT_A2, CLIENT_B, B]);
    await pool.query(
      "INSERT INTO practice_jobs (id, company_id, practice_client_id, title) VALUES ($1, $2, $3, 'R073 job')",
      [JOB_A, A, CLIENT_A]);
    await pool.query(
      "INSERT INTO practice_entry_templates (id, company_id, user_id, name, practice_client_id) VALUES ($1, $2, $3, 'R073 tpl', $4)",
      [TEMPLATE_A, A, USER, CLIENT_A]);
    token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const t of ['practice_client_contacts', 'practice_entry_templates', 'practice_jobs', 'practice_clients',
        'company_users']) {
        await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
      }
      await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
      await pool.query('DELETE FROM users WHERE id = $1', [USER]);
    } finally {
      await pool.end();
    }
  });

  describe('client-contacts POST', () => {
    it('refuses company B\'s practice client with a 400 and stores no contact', async () => {
      const state = await call(clientContacts, 'POST', { clientId: CLIENT_B, name: 'Planted contact' });
      expect(state.statusCode).toBe(400);
      expect(await contactsOn(CLIENT_B)).toBe(0);
    });

    it('still stores a contact on company A\'s own practice client', async () => {
      const state = await call(clientContacts, 'POST', { clientId: CLIENT_A, name: 'Own contact', isPrimary: true });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
      expect(await contactsOn(CLIENT_A)).toBe(1);
    });

    it('refuses a malformed id with a 400, not a 500', async () => {
      const state = await call(clientContacts, 'POST', { clientId: 'not-a-uuid', name: 'Bad id' });
      expect(state.statusCode).toBe(400);
    });

    it('answers an absent clientId as before: 400 and nothing written', async () => {
      const before = await count('SELECT count(*) AS n FROM practice_client_contacts WHERE company_id = $1', [A]);
      const state = await call(clientContacts, 'POST', { name: 'No client' });
      expect(state.statusCode).toBe(400);
      expect(await count('SELECT count(*) AS n FROM practice_client_contacts WHERE company_id = $1', [A]))
        .toBe(before);
    });
  });

  describe('jobs/[id] PUT', () => {
    const jobClient = async () =>
      String((await pool.query('SELECT practice_client_id FROM practice_jobs WHERE id = $1', [JOB_A]))
        .rows[0].practice_client_id);

    it('refuses re-pointing A\'s job at company B\'s client, and the job keeps its own', async () => {
      const state = await call(jobById, 'PUT', { practiceClientId: CLIENT_B }, JOB_A);
      expect(state.statusCode).toBe(400);
      expect(await jobClient()).toBe(CLIENT_A);
    });

    it('still re-points A\'s job at another of A\'s own clients', async () => {
      const state = await call(jobById, 'PUT', { practiceClientId: CLIENT_A2 }, JOB_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      expect(await jobClient()).toBe(CLIENT_A2);
    });

    it('an update naming no client leaves the client as it was', async () => {
      const state = await call(jobById, 'PUT', { title: 'R073 job renamed' }, JOB_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      expect(await jobClient()).toBe(CLIENT_A2);
    });
  });

  describe('entry-templates POST', () => {
    const templatesOn = (clientId: string) =>
      count('SELECT count(*) AS n FROM practice_entry_templates WHERE company_id = $1 AND practice_client_id = $2',
        [A, clientId]);

    it('refuses company B\'s practice client with a 400 and stores no template', async () => {
      const state = await call(entryTemplates, 'POST', { name: 'Planted tpl', practiceClientId: CLIENT_B });
      expect(state.statusCode).toBe(400);
      expect(await templatesOn(CLIENT_B)).toBe(0);
    });

    it('still stores a template on A\'s own client', async () => {
      const state = await call(entryTemplates, 'POST', { name: 'Own tpl', practiceClientId: CLIENT_A2 });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
      expect(await templatesOn(CLIENT_A2)).toBe(1);
    });

    it('still stores a template with no client, as before', async () => {
      const state = await call(entryTemplates, 'POST', { name: 'Clientless tpl' });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
      expect(await count(
        "SELECT count(*) AS n FROM practice_entry_templates WHERE company_id = $1 AND name = 'Clientless tpl' AND practice_client_id IS NULL",
        [A])).toBe(1);
    });
  });

  describe('entry-templates/[id] PUT', () => {
    const templateClient = async () =>
      String((await pool.query('SELECT practice_client_id FROM practice_entry_templates WHERE id = $1', [TEMPLATE_A]))
        .rows[0].practice_client_id);

    it('refuses re-pointing A\'s template at company B\'s client, and it keeps its own', async () => {
      const state = await call(entryTemplateById, 'PUT', { practiceClientId: CLIENT_B }, TEMPLATE_A);
      expect(state.statusCode).toBe(400);
      expect(await templateClient()).toBe(CLIENT_A);
    });

    it('still re-points A\'s template at another of A\'s own clients', async () => {
      const state = await call(entryTemplateById, 'PUT', { practiceClientId: CLIENT_A2 }, TEMPLATE_A);
      expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
      expect(await templateClient()).toBe(CLIENT_A2);
    });
  });

  // Through withAuth, forced RLS already hides B's client from app_user, so the
  // routes above would refuse it even without the fence's company predicate.
  // Called on the owner connection (as a cron or any non-withAuth caller runs),
  // only that predicate stands between B's client and a write.
  describe('the fence itself, outside RLS', () => {
    it('refuses company B\'s client and passes A\'s own and an absent id', async () => {
      await expect(assertPracticeClientInCompany(A, CLIENT_B)).rejects.toBeInstanceOf(PracticeClientNotInCompanyError);
      await expect(assertPracticeClientInCompany(A, CLIENT_A)).resolves.toBeUndefined();
      await expect(assertPracticeClientInCompany(A, null)).resolves.toBeUndefined();
    });
  });
});
