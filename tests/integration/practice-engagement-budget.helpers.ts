// Shared fixture for the Engagement Budget suites (practice-engagement-budget*.int.test.ts).
//
// Runs against isaflow_dev (allow-listed by assertNotProductionDb): each suite
// builds its OWN random-UUID companies A and B and removes them in afterAll,
// so the suites are independent of each other and of file parallelism.
// Fixture rows are written by the owner role; service calls run in a
// transaction carried by `als`, as withAuth runs them; route calls go through
// the real handler (withAuth → app_user + RLS).

import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';

export type Handler = (req: never, res: never) => Promise<unknown> | unknown;
export type RouteState = { statusCode: number; body: { data?: unknown; error?: { code?: string; message?: string } } };

export const ebDbAvailable = Boolean(process.env.DATABASE_URL && process.env.JWT_SECRET);

export interface EbFixture {
  pool: Pool;
  A: string; B: string; USER: string;
  CLIENT: string; CLIENT2: string; CLIENT_B: string;
  CAT: string; ITEM: string; CAT_B: string; ITEM_B: string;
  inTx<T>(fn: () => Promise<T>): Promise<T>;
  /** A job row; returns its id. */
  job(company: string, client: string, title: string, opts?: { budget?: number | null; hours?: number | null; status?: string }): Promise<string>;
  /** A time entry row written as the owner. */
  entry(opts: { company?: string; client?: string; job: string | null; hours: number; rate: number | null; status?: string; billable?: boolean; desc?: string }): Promise<string>;
  /** A LEGACY row that migration 851's FK would refuse (written with triggers off, as a pre-851 row). */
  plantLegacy(opts: { company: string; client: string; cat: string; item: string; job: string; hours: number; rate: number; desc: string }): Promise<string>;
  call(handler: Handler, method: string, body: unknown, query?: Record<string, string>): Promise<RouteState>;
  jobOf(entryId: string): Promise<string | null>;
  entriesNamed(desc: string): Promise<number>;
  cleanup(): Promise<void>;
}

export async function createEbFixture(tag: string): Promise<EbFixture> {
  assertNotProductionDb(`The ${tag} suite writes practice clients, jobs and time entries.`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const [A, B, USER, CLIENT, CLIENT2, CLIENT_B, CAT, ITEM, CAT_B, ITEM_B] = Array.from({ length: 10 }, () => randomUUID()) as
    [string, string, string, string, string, string, string, string, string, string];

  await pool.query('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true), ($3, $4, true)',
    [A, `${tag} Co A`, B, `${tag} Co B`]);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)",
    [USER, `${tag.toLowerCase()}-${USER}@isaflow.test`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, USER]);
  await pool.query(
    `INSERT INTO practice_clients (id, company_id, legal_name, trading_name, billing_model, status) VALUES
       ($1, $2, $6 || ' Client Ltd', $6 || ' Client', 'hourly', 'active'),
       ($3, $2, $6 || ' Client 2 Ltd', NULL, 'hourly', 'active'),
       ($4, $5, $6 || ' Client B', NULL, 'hourly', 'active')`,
    [CLIENT, A, CLIENT2, CLIENT_B, B, tag]);
  await pool.query('INSERT INTO practice_job_categories (id, company_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
    [CAT, A, `${tag} cat`, CAT_B, B, `${tag} cat B`]);
  await pool.query('INSERT INTO practice_work_items (id, company_id, category_id, name) VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)',
    [ITEM, A, CAT, `${tag} item`, ITEM_B, B, CAT_B, `${tag} item B`]);
  await pool.query("INSERT INTO practice_staff_rates (company_id, user_id, rate, effective_from) VALUES ($1, $2, 1000, '2020-01-01')",
    [A, USER]);
  const token = await new SignJWT({ sub: USER, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));

  async function inTx<T>(fn: () => Promise<T>): Promise<T> {
    const c: PoolClient = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await als.run({ client: c, userId: USER, companyId: A, claims: {} } as never, fn);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally { c.release(); }
  }

  const insertEntry = (c: Pool | PoolClient, v: unknown[]) => c.query(
    `INSERT INTO time_entries (company_id, user_id, entry_date, hours, practice_client_id, job_category_id,
       work_item_id, task_description, billable, applied_rate, line_total, status, job_id)
     VALUES ($1, $2, '2026-01-10', $3, $4, $5, $6, $7, $8, $9::numeric, ROUND($3::numeric * $9::numeric, 2), $10, $11)
     RETURNING id`, v);

  return {
    pool, A, B, USER, CLIENT, CLIENT2, CLIENT_B, CAT, ITEM, CAT_B, ITEM_B, inTx,
    async job(company, client, title, opts = {}) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO practice_jobs (id, company_id, practice_client_id, title, budget_amount, budgeted_hours, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, company, client, title, opts.budget ?? null, opts.hours ?? null, opts.status ?? 'in_progress']);
      return id;
    },
    async entry(o) {
      const inB = (o.company ?? A) === B;
      const r = await insertEntry(pool, [o.company ?? A, USER, o.hours, o.client ?? (inB ? CLIENT_B : CLIENT),
        inB ? CAT_B : CAT, inB ? ITEM_B : ITEM, o.desc ?? `${tag} fixture`, o.billable ?? true, o.rate,
        o.status ?? 'draft', o.job]);
      return String(r.rows[0].id);
    },
    async plantLegacy(o) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        const r = await insertEntry(c, [o.company, USER, o.hours, o.client, o.cat, o.item, o.desc, true, o.rate, 'approved', o.job]);
        await c.query('COMMIT');
        return String(r.rows[0].id);
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally { c.release(); }
    },
    async call(handler, method, body, query = {}) {
      const req = request({ 'sb-access-token': token, active_company_id: A }, method) as never as
        { body: unknown; url: string; query: Record<string, string> };
      req.body = body;
      req.query = query;
      req.url = `/api/accounting/practice/${tag.toLowerCase()}-fixture`;
      const out = response();
      await handler(req as never, out.res as never);
      return out.state as RouteState;
    },
    async jobOf(entryId) {
      return (await pool.query('SELECT job_id FROM time_entries WHERE id = $1', [entryId])).rows[0]?.job_id ?? null;
    },
    async entriesNamed(desc) {
      return Number((await pool.query(
        'SELECT count(*) AS n FROM time_entries WHERE company_id = ANY($1::uuid[]) AND task_description = $2',
        [[A, B], desc])).rows[0].n);
    },
    async cleanup() {
      try {
        for (const t of ['time_entries', 'practice_jobs', 'practice_entry_templates', 'practice_staff_rates',
          'practice_work_items', 'practice_job_categories', 'practice_clients', 'company_users']) {
          await pool.query(`DELETE FROM ${t} WHERE company_id = ANY($1::uuid[])`, [[A, B]]);
        }
        await pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[A, B]]);
        await pool.query('DELETE FROM users WHERE id = $1', [USER]);
      } finally {
        await pool.end();
      }
    },
  };
}
