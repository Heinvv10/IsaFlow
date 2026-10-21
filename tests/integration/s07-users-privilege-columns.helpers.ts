/**
 * Fixture for s07-users-privilege-columns.int.test.ts: run SQL, a service
 * function or a real route as a named database role against the disposable
 * schema fixture.
 *
 * The suite's pool connects as `postgres`, which owns `users` and is never
 * checked against column privileges, so every probe here first issues
 * `SET LOCAL ROLE` to the role under test, exactly as withAuth
 * (app_user) does. platform_admin is reached the same way: the harness points
 * PLATFORM_ADMIN_DATABASE_URL at `postgres`, so driving an admin route would
 * prove nothing about the platform_admin role itself.
 */
import type { NextApiRequest } from 'next';
import { Pool } from 'pg';
import { als } from '@/lib/als';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
export const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

export type DbRole = 'app_user' | 'platform_admin' | 'migration_admin';

/**
 * DATABASE_URL, but every connection made from it runs as `role`
 * (`options=-c role=...`; postgres is a member of each). Lets a route that
 * builds its own pool from MIGRATION_ADMIN_DATABASE_URL run as the role it has
 * in production instead of the harness's superuser.
 */
export function urlAsRole(role: DbRole): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('options', `-c role=${role}`);
  return url.toString();
}
type Query = (text: string, params?: unknown[]) => Promise<unknown>;

/** A refused statement's SQLSTATE and message; null when it succeeded. */
export interface Refusal { code: string; message: string }

/**
 * Run `body` as `role` with the JWT claims of `sub`, inside a transaction that
 * is always rolled back. Returns the refusal, or null when the body succeeded.
 */
export async function asRole(role: DbRole, sub: string, body: (q: Query) => Promise<void>): Promise<Refusal | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub })]);
    await client.query(`SET LOCAL ROLE ${role}`);
    try {
      await body((text, params) => client.query(text, params as unknown[]));
      return null;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code ?? 'none', message: e.message ?? String(err) };
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Run a service function the way withAuth / withPlatformAdmin run it: `sql`
 * bound through ALS to one client that has `SET LOCAL ROLE role`. Commits on
 * success, so the caller can read the outcome back.
 */
export async function inServiceContext(role: DbRole, sub: string, fn: () => Promise<unknown>): Promise<void> {
  const client = await pool.connect();
  let ok = false;
  try {
    await client.query('BEGIN');
    const claims = { sub };
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await client.query(`SET LOCAL ROLE ${role}`);
    await als.run({ client, userId: sub, claims }, fn);
    ok = true;
  } finally {
    await client.query(ok ? 'COMMIT' : 'ROLLBACK');
    client.release();
  }
}

type Route = (req: never, res: never) => Promise<unknown>;

/**
 * Call a real route as `sub`: an aal2 session (no GoTrue round trip) with a
 * session id, which the impersonation guard needs to recognise it as the
 * user's own.
 */
export async function callRoute(route: unknown, opts: {
  sub: string; method: string; body?: unknown; query?: Record<string, string>; companyId?: string;
}): Promise<{ status: number; body: unknown }> {
  const jar: Record<string, string> = { 'sb-access-token': await signSession(opts.sub, crypto.randomUUID(), 'aal2') };
  if (opts.companyId) jar.active_company_id = opts.companyId;
  const req = request(jar, opts.method) as NextApiRequest & { body: unknown };
  req.body = opts.body ?? {};
  req.query = opts.query ?? {};
  const result = response();
  await (route as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body };
}

export async function userRow(id: string): Promise<Record<string, unknown>> {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] as Record<string, unknown>;
}
