/**
 * S-07b deploy check (scripts/deploy.sh, after migrations, before the code
 * switch): the app's login roles (migrations 915, 915b) still cannot
 * reach the owner, and, once either can log in, the runbook's out-of-band
 * controls are in place (docs/runbooks/s07b-app-pool-login-roles.md, steps 2
 * and 3b). Exits 1 on any violation, 0 otherwise.
 *
 * Usage: DATABASE_URL=<owner URL> bun scripts/check-app-login-roles.ts
 */
import { closeSql, createSql, type TaggedSql } from './_pg';

export async function appLoginRoleViolations(sql: TaggedSql): Promise<string[] | null> {
  const [fn] = await sql<{ f: string | null }>`SELECT to_regprocedure('public.app_login_role_violations(boolean)')::text AS f`;
  if (!fn?.f) return null;
  const [login] = await sql<{ live: boolean }>`
    SELECT COALESCE(bool_or(rolcanlogin), false) AS live FROM pg_roles WHERE rolname IN ('isaflow_app', 'isaflow_service')`;
  const rows = await sql<{ v: string }>`SELECT public.app_login_role_violations(${login?.live ?? false}) AS v`;
  return rows.map((r) => r.v);
}

async function main(): Promise<number> {
  const sql = createSql();
  try {
    const violations = await appLoginRoleViolations(sql);
    if (violations === null) {
      console.log('app login roles: migration 915b not applied; nothing to check');
      return 0;
    }
    for (const v of violations) console.error(`FAIL: ${v}`);
    if (violations.length === 0) console.log('app login roles: OK');
    return violations.length === 0 ? 0 : 1;
  } finally {
    await closeSql();
  }
}

if ((import.meta as { main?: boolean }).main) {
  main().then((code) => process.exit(code), (err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
