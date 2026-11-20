/**
 * Run the app's real services through the production LOGIN, not the fixture superuser: session_user is isaflow_app
 * (non-superuser, NOINHERIT), and every request transaction does `SET LOCAL ROLE app_user` with the member's claims and
 * the active company, as withAuth does. So the ledger rules of migration 1018 (which exempt only a superuser) bind
 * every write here, including the writes of a service that opens its own transaction through the app's pool.
 *
 * Usage: seed with the fixture helpers (they use the module instance loaded at the top of the file, on the fixture's
 * superuser pool), call `appLoginWorld()`, then import the services DYNAMICALLY from the returned `load`, which resets
 * the module registry so the services get a fresh `@/lib/neon` pool that logs in as isaflow_app.
 */
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { vi } from 'vitest';

export interface AppWorld {
  /** A fresh import of a module, bound to the isaflow_app pool. */
  load: <T>(importer: () => Promise<T>) => Promise<T>;
  /** One request transaction as isaflow_app -> app_user, committed on success, rolled back on a throw. */
  run: <T>(who: { userId: string; companyId: string }, fn: () => Promise<T>) => Promise<T>;
  /** session_user, current_user and is_superuser as the request transaction sees them. */
  probe: (who: { userId: string; companyId: string }) => Promise<{ sessionUser: string; currentUser: string; superuser: string }>;
  close: () => Promise<void>;
}

export async function appLoginWorld(): Promise<AppWorld> {
  const fixtureUrl = process.env.DATABASE_URL!;
  const su = new Pool({ connectionString: fixtureUrl, max: 1 });
  const password = randomUUID();
  await su.query(`ALTER ROLE isaflow_app LOGIN PASSWORD '${password}'`);
  await su.end();
  const url = new URL(fixtureUrl);
  url.username = 'isaflow_app';
  url.password = password;
  vi.stubEnv('DATABASE_URL', url.toString());
  vi.stubEnv('SERVICE_DATABASE_URL', url.toString());
  vi.resetModules();

  const { als } = await import('@/lib/als');
  const { getPoolForTests } = await import('@/lib/neon');

  const open = async (who: { userId: string; companyId: string }) => {
    const client = await getPoolForTests().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.userId, role: 'authenticated' })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [who.companyId]);
      return client;
    } catch (err) {
      client.release();
      throw err;
    }
  };

  return {
    load: (importer) => importer(),
    run: async (who, fn) => {
      const client = await open(who);
      try {
        const out = await als.run({ client, userId: who.userId, companyId: who.companyId, claims: { sub: who.userId } } as never, fn);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    probe: async (who) => {
      const client = await open(who);
      try {
        const r = (await client.query("SELECT session_user AS s, current_user AS c, current_setting('is_superuser') AS su")).rows[0];
        return { sessionUser: String(r.s), currentUser: String(r.c), superuser: String(r.su) };
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    },
    close: async () => { vi.unstubAllEnvs(); await (await import('@/lib/neon')).getPoolForTests().end().catch(() => undefined); },
  };
}
