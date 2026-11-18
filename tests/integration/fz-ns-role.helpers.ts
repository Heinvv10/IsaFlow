/**
 * A throwaway stand-in for production's postgres in the FZ breaker suites: NOSUPERUSER, BYPASSRLS, and a member of the
 * fixture's postgres, migration_admin and app_user, so it holds the table owner's rights the way production's
 * non-superuser postgres does. Roles are cluster-wide and outlive a suite (r035-n1b's audit_log census saw one), so
 * each suite gets its own name, drops it in afterAll, and first drops any fz_pg_ns_* left by a crashed run over an
 * hour ago (the name carries its creation time).
 */
import type { Pool } from 'pg';

const PREFIX = 'fz_pg_ns_';
const STALE_MS = 60 * 60 * 1000;

export function nsRole(su: Pool) {
  const name = `${PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    name,
    async create(): Promise<void> {
      const old = (await su.query(`SELECT rolname FROM pg_roles WHERE rolname = 'fz_pg_ns' OR rolname LIKE 'fz\\_pg\\_ns\\_%'`)).rows
        .map((r: { rolname: string }) => r.rolname)
        .filter((n: string) => n === 'fz_pg_ns' || Date.now() - Number(n.slice(PREFIX.length).split('_')[0]) > STALE_MS);
      for (const n of old) await su.query(`DROP ROLE IF EXISTS ${n}`);
      await su.query(`CREATE ROLE ${name} NOLOGIN NOSUPERUSER INHERIT BYPASSRLS`);
      await su.query(`GRANT postgres, migration_admin, app_user TO ${name}`);
    },
    async drop(): Promise<void> {
      await su.query(`DROP ROLE IF EXISTS ${name}`);
    },
  };
}
