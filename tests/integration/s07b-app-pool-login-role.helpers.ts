/**
 * Fixture for s07b-app-pool-login-role.int.test.ts: real logins as the app's
 * login roles (migration 910), and probes that report how a statement was
 * refused.
 *
 * The roles must be reached by a real LOGIN, not `options=-c role=X` on the
 * harness's `postgres` URL: RESET ROLE and set_config('role','none') return to
 * the SESSION user, which with `-c role=` would still be `postgres`.
 */
import type { NextApiRequest } from 'next';
import { Pool, type PoolClient } from 'pg';
import { response } from './mfa-impersonation-postgres.helpers';

/** The login roles migration 910 creates, and the pool each one serves. */
export type LoginRole = 'isaflow_app' | 'isaflow_service';

/**
 * Give `role` LOGIN and a password (as the ops step does in production) and
 * return DATABASE_URL rewritten to log in as it. `fixture` is the harness's
 * own connection, captured before the suite repoints DATABASE_URL.
 */
export async function loginUrl(fixture: Pool, fixtureUrl: string, role: LoginRole): Promise<string> {
  const password = crypto.randomUUID();
  await fixture.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
  const url = new URL(fixtureUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** A refused statement's SQLSTATE and message; null when everything succeeded. */
export interface Refusal { code: string; message: string }

/**
 * Run `steps` in order on one client of `pool`, inside a transaction that is
 * always rolled back. The transaction opens the way withAuth's does (BEGIN,
 * SET LOCAL ROLE app_user, the caller's claims) when `asRequest` is set.
 */
export async function attempt(pool: Pool, steps: Array<[string, unknown[]?]>,
  opts: { asRequest?: { sub: string; companyId: string } } = {}): Promise<Refusal | null> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opts.asRequest) {
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: opts.asRequest.sub })]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [opts.asRequest.companyId]);
    }
    try {
      for (const [text, params] of steps) await client.query(text, params);
      return null;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code ?? 'none', message: e.message ?? String(err) };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    // A session-level SET ROLE / SET SESSION AUTHORIZATION that got through
    // must not ride back into the pool.
    client.release(true);
  }
}

type Route = (req: never, res: never) => Promise<unknown>;

/** Call a cron route the way the systemd timers do: POST with X-Cron-Secret. */
export async function callCron(route: unknown, secret: string): Promise<{ status: number; body: unknown }> {
  const req = { method: 'POST', url: '/api/cron/fixture', headers: { 'x-cron-secret': secret },
    cookies: {}, query: {}, body: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as NextApiRequest;
  const result = response();
  await (route as Route)(req as never, result.res as never);
  return { status: result.state.statusCode, body: result.state.body };
}

/** The last top-level `DO $$ ... END $$;` block of a migration: 910's guard. */
export function lastDoBlock(migrationText: string): string {
  const start = migrationText.lastIndexOf('\nDO $$');
  const end = migrationText.indexOf('END $$;', start);
  if (start < 0 || end < 0) throw new Error('no DO block found');
  return migrationText.slice(start + 1, end + 'END $$;'.length);
}
