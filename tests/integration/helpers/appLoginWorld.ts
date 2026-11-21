/**
 * Run the app's real services through a login of the production login's shape, not the fixture superuser: session_user
 * is the suite's login (isaflow_app's memberships, non-superuser, NOINHERIT; never isaflow_app itself, round 11), and every request transaction does `SET LOCAL ROLE app_user` with the member's claims and
 * the active company, as withAuth does. So the ledger rules of migration 1018 (which exempt only a superuser) bind
 * every write here, including the writes of a service that opens its own transaction through the app's pool.
 *
 * Usage: seed with the fixture helpers (they use the module instance loaded at the top of the file, on the fixture's
 * superuser pool), call `appLoginWorld()`, then import the services DYNAMICALLY from the returned `load`, which resets
 * the module registry so the services get a fresh `@/lib/neon` pool that logs in as the suite's login.
 */
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { vi } from 'vitest';

/**
 * The fixture's own login (round 11, codex gate): a localhost test database can share its cluster with a running app, so
 * the cluster-wide isaflow_app password is never touched. Each suite's login has the production login's SHAPE: LOGIN,
 * not a superuser, NOINHERIT, and exactly isaflow_app's memberships with the same INHERIT / SET options (app_user, SET
 * only), copied from pg_auth_members, and no grant of its own. The rules of 1018 read is_superuser and the role a
 * request SETs, never the login's name.
 *
 * Round 12 (breaker L2, codex blocker): one role PER SUITE (`ci_lf_app_<random>`), its random password held in this
 * process's memory only and stored nowhere (the server keeps only its SCRAM verifier, readable by superusers alone),
 * created only on a cluster that holds nothing but disposable databases, and dropped when the suite's world closes. No
 * suite reads or changes another suite's login.
 */
export const FIXTURE_LOGIN_PREFIX = 'ci_lf_app_';

/** The databases a cluster may hold for a fixture login to exist on it (round 12 L2). */
export const DISPOSABLE_CLUSTER_DATABASES = ['template0', 'template1', 'postgres', 'isaflow_test', 'isaflow_schema_fixture'];

/**
 * Round 12 L2: a LOGIN role is cluster-wide, so it is created only on a cluster that holds nothing but disposable
 * databases (a test database beside a real one would hand the real one a working app login).
 */
export async function assertDisposableCluster(c: { query: Client['query'] }): Promise<void> {
  const { rows } = await c.query<{ datname: string }>('SELECT datname FROM pg_database ORDER BY 1');
  const other = rows.map((r) => r.datname).filter((d) => !DISPOSABLE_CLUSTER_DATABASES.includes(d));
  if (other.length > 0) {
    throw new Error(`appLoginWorld: refusing a fixture login on a cluster that also holds ${other.join(', ')}`);
  }
}

const adminClient = async (fixtureUrl: string): Promise<Client> => {
  const admin = new URL(fixtureUrl);
  admin.pathname = '/postgres';
  const c = new Client({ connectionString: admin.toString() });
  await c.connect();
  return c;
};

/** A fresh login of isaflow_app's shape for one suite: its name and its password (in memory only). */
export async function provisionAppLogin(fixtureUrl: string): Promise<{ role: string; password: string }> {
  const c = await adminClient(fixtureUrl);
  try {
    await assertDisposableCluster(c);
    const role = `${FIXTURE_LOGIN_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const password = randomUUID();
    await c.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`);
    const grants = (await c.query<{ role: string; inherit: boolean; set: boolean }>(`
      SELECT g.rolname AS role, m.inherit_option AS inherit, m.set_option AS set
        FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
       WHERE m.member = 'isaflow_app'::regrole`)).rows;
    for (const g of grants) {
      await c.query(`GRANT ${g.role} TO ${role} WITH INHERIT ${g.inherit ? 'TRUE' : 'FALSE'}, SET ${g.set ? 'TRUE' : 'FALSE'}`);
    }
    return { role, password };
  } finally {
    await c.end();
  }
}

/** Drop one suite's login (round 12 L2). Only a fixture login: the name must carry the prefix. */
export async function dropAppLogin(fixtureUrl: string, role: string): Promise<void> {
  if (!role.startsWith(FIXTURE_LOGIN_PREFIX) || !/^[a-z0-9_]+$/.test(role)) throw new Error(`not a fixture login: ${role}`);
  const c = await adminClient(fixtureUrl);
  try {
    await c.query(`DROP ROLE IF EXISTS ${role}`);
  } finally {
    await c.end();
  }
}

export interface AppWorld {
  /** A fresh import of a module, bound to the suite's login pool. */
  load: <T>(importer: () => Promise<T>) => Promise<T>;
  /** One request transaction as the suite's login -> app_user, committed on success, rolled back on a throw. */
  run: <T>(who: { userId: string; companyId: string }, fn: () => Promise<T>) => Promise<T>;
  /** session_user, current_user and is_superuser as the request transaction sees them. */
  probe: (who: { userId: string; companyId: string }) => Promise<{ sessionUser: string; currentUser: string; superuser: string }>;
  close: () => Promise<void>;
  /** This suite's login (session_user of every request transaction). */
  login: string;
}

export async function appLoginWorld(): Promise<AppWorld> {
  const fixtureUrl = process.env.DATABASE_URL!;
  const { role: login, password } = await provisionAppLogin(fixtureUrl);
  const url = new URL(fixtureUrl);
  url.username = login;
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
    login,
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
    close: async () => {
      await (await import('@/lib/neon')).getPoolForTests().end().catch(() => undefined);
      vi.unstubAllEnvs();
      await dropAppLogin(fixtureUrl, login);
    },
  };
}
