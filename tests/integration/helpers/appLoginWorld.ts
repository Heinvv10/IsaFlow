/**
 * Run the app's real services through a login of the production login's shape, not the fixture superuser: session_user
 * is FIXTURE_LOGIN (isaflow_app's memberships, non-superuser, NOINHERIT; never isaflow_app itself, round 11), and every request transaction does `SET LOCAL ROLE app_user` with the member's claims and
 * the active company, as withAuth does. So the ledger rules of migration 1018 (which exempt only a superuser) bind
 * every write here, including the writes of a service that opens its own transaction through the app's pool.
 *
 * Usage: seed with the fixture helpers (they use the module instance loaded at the top of the file, on the fixture's
 * superuser pool), call `appLoginWorld()`, then import the services DYNAMICALLY from the returned `load`, which resets
 * the module registry so the services get a fresh `@/lib/neon` pool that logs in as FIXTURE_LOGIN.
 */
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { vi } from 'vitest';

const LOGIN_LOCK = 'ci:isaflow_app_login';
/**
 * The fixture's own login (round 11, codex gate): a localhost test database can share its cluster with a running app, so
 * the cluster-wide isaflow_app password is never touched. This role has the production login's SHAPE: LOGIN, not a
 * superuser, NOINHERIT, and exactly isaflow_app's memberships with the same INHERIT / SET options (app_user, SET only),
 * copied from pg_auth_members, and no grant of its own. The rules of 1018 read is_superuser and the role a request SETs,
 * never the login's name.
 */
export const FIXTURE_LOGIN = 'ci_ledger_freeze_app';

/**
 * Its password, provisioned ONCE per cluster and shared (round 8): a role and its password are cluster-wide, so a
 * suite that rotated it would cut off another suite's NEW connections on the same cluster (its open ones keep
 * working). Kept in a superuser-only table of the cluster's `postgres` database, under a session advisory lock, so the
 * first caller sets it and every later or concurrent caller reads the same value.
 */
async function logsIn(fixtureUrl: string, password: string): Promise<boolean> {
  const url = new URL(fixtureUrl);
  url.username = FIXTURE_LOGIN;
  url.password = password;
  const probe = new Client({ connectionString: url.toString() });
  try {
    await probe.connect();
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '28P01') return false;
    throw err;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

export async function provisionAppLogin(fixtureUrl: string): Promise<string> {
  const admin = new URL(fixtureUrl);
  admin.pathname = '/postgres';
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock(hashtext($1))', [LOGIN_LOCK]);
    await c.query('CREATE TABLE IF NOT EXISTS public.ci_isaflow_app_login (password text NOT NULL)');
    await c.query('REVOKE ALL ON public.ci_isaflow_app_login FROM PUBLIC');
    const exists = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [FIXTURE_LOGIN])).rowCount === 1;
    if (!exists) await c.query(`CREATE ROLE ${FIXTURE_LOGIN} LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    const grants = (await c.query<{ role: string; inherit: boolean; set: boolean }>(`
      SELECT g.rolname AS role, m.inherit_option AS inherit, m.set_option AS set
        FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
       WHERE m.member = 'isaflow_app'::regrole`)).rows;
    for (const g of grants) {
      await c.query(`GRANT ${g.role} TO ${FIXTURE_LOGIN} WITH INHERIT ${g.inherit ? 'TRUE' : 'FALSE'}, SET ${g.set ? 'TRUE' : 'FALSE'}`);
    }
    const { rows } = await c.query<{ password: string }>('SELECT password FROM public.ci_isaflow_app_login LIMIT 1');
    // The stored one, while it still logs in (anything that rotated the role outside this helper made it stale).
    if (exists && rows[0] && await logsIn(fixtureUrl, rows[0].password)) return rows[0].password;
    const password = randomUUID();
    await c.query(`ALTER ROLE ${FIXTURE_LOGIN} PASSWORD '${password}'`);
    await c.query('DELETE FROM public.ci_isaflow_app_login');
    await c.query('INSERT INTO public.ci_isaflow_app_login (password) VALUES ($1)', [password]);
    return password;
  } finally {
    await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOGIN_LOCK]).catch(() => undefined);
    await c.end();
  }
}

export interface AppWorld {
  /** A fresh import of a module, bound to the FIXTURE_LOGIN pool. */
  load: <T>(importer: () => Promise<T>) => Promise<T>;
  /** One request transaction as FIXTURE_LOGIN -> app_user, committed on success, rolled back on a throw. */
  run: <T>(who: { userId: string; companyId: string }, fn: () => Promise<T>) => Promise<T>;
  /** session_user, current_user and is_superuser as the request transaction sees them. */
  probe: (who: { userId: string; companyId: string }) => Promise<{ sessionUser: string; currentUser: string; superuser: string }>;
  close: () => Promise<void>;
}

export async function appLoginWorld(): Promise<AppWorld> {
  const fixtureUrl = process.env.DATABASE_URL!;
  const password = await provisionAppLogin(fixtureUrl);
  const url = new URL(fixtureUrl);
  url.username = FIXTURE_LOGIN;
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
