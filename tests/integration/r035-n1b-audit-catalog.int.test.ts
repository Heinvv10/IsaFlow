/**
 * R-035 N1b (A, migration 880), the CATALOGUE half — read-only, so it runs
 * against whatever DATABASE_URL names (a fixture, or isaflow_dev in a local
 * `bun run ci`); it skips only without a database.
 *
 * The unit census (auditLogAppendOnlyCensus) reads source TEXT; this reads what
 * the database holds:
 *  - no role but the table's owner (and superusers, and the session's own role
 *    through the owner — the deploy role on production, exempt exactly as 880
 *    and 872 exempt it) holds UPDATE, DELETE, TRUNCATE or TRIGGER on
 *    audit_log, or a column UPDATE, directly, via PUBLIC or via membership;
 *  - app_user and platform_admin still INSERT and SELECT (append-only, not
 *    read-only);
 *  - no function body names audit_log in an UPDATE, DELETE, TRUNCATE or MERGE
 *    (a SECURITY DEFINER one callable by app_user would hand the erase back).
 * The triggers and rewrite rules on audit_log (none) are pinned by
 * r035-n1-catalog.int.test.ts.
 *
 * LIMIT, as in r035-n1-catalog: a function that builds its statement at run
 * time (`EXECUTE 'DELETE FROM audit' || '_log'`) names no table this can read.
 * Migration review is the control for that.
 *
 * A database without 880 fails here by design, and says so.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
afterAll(() => pool.end());

const NOT_APPLIED = 'migration 880 is not applied to this database — apply it (isaflow_dev needs Hein\'s OK) or unset DATABASE_URL';

/** A static erase naming the table: UPDATE/DELETE/TRUNCATE/MERGE, ONLY, schema-qualified or quoted. */
const ERASE_STATEMENT = String.raw`(update|delete\s+from|truncate(\s+table)?|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?audit_log\M`;

/** Every role that is neither superuser, predefined (pg_*), the owner, nor the session's own role through the owner; and PUBLIC. */
const OTHERS = `
  SELECT r.rolname AS who FROM pg_roles r
  WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> $1::oid
    AND NOT (r.rolname = session_user AND pg_has_role(r.oid, $1::oid, 'USAGE'))
  UNION ALL SELECT 'public'`;

describeIfDb('audit_log catalogue (R-035 N1b A)', () => {
  it('no role but the owner may update, delete, truncate or trigger it — directly, via PUBLIC or via membership', async () => {
    const { rows: [t] } = await pool.query("SELECT relowner FROM pg_class WHERE oid = 'public.audit_log'::regclass");
    const { rows } = await pool.query(`
      SELECT x.who, priv FROM (${OTHERS}) x, unnest(ARRAY['UPDATE','DELETE','TRUNCATE','TRIGGER']) priv
      WHERE has_table_privilege(x.who, 'public.audit_log', priv)
      UNION ALL
      SELECT x.who, 'column UPDATE' FROM (${OTHERS}) x
      WHERE has_any_column_privilege(x.who, 'public.audit_log', 'UPDATE')
      ORDER BY 1, 2`, [t.relowner]);
    expect(rows, NOT_APPLIED).toEqual([]);
  });

  it('app_user and platform_admin still insert and read it', async () => {
    const { rows } = await pool.query(`
      SELECT who, priv FROM unnest(ARRAY['app_user','platform_admin']) who, unnest(ARRAY['INSERT','SELECT']) priv
      WHERE NOT has_table_privilege(who, 'public.audit_log', priv)`);
    expect(rows).toEqual([]);
  });

  it('no function body updates, deletes, truncates or merges audit_log (static SQL only — see LIMIT)', async () => {
    const { rows } = await pool.query(`
      SELECT p.oid::regprocedure::text AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosrc ~* $1
      ORDER BY 1`, [ERASE_STATEMENT]);
    expect(rows).toEqual([]);
  });
});
