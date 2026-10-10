/**
 * R-035 N1b (C, migration 883), the CATALOGUE half — read-only, so it runs
 * against whatever DATABASE_URL names; it skips only without a database.
 *
 *  - each table carries exactly its guard: one enabled BEFORE INSERT OR
 *    UPDATE OR DELETE row trigger (and no rewrite rule);
 *  - the guards, the role lookup and the owner predicate they share are the
 *    bodies 883 and 886 ship (md5) and SECURITY INVOKER — the guard judges
 *    `current_user`, which a DEFINER would replace with its owner;
 *  - TRUNCATE (which fires no row trigger) and TRIGGER are held by no role
 *    but the owner, migration_admin and the session's role through the owner;
 *  - INSERT, UPDATE and DELETE by no role the guards do not judge: only
 *    app_user, platform_admin and migration_admin (and the owner, superusers,
 *    the session's role through the owner).
 *
 * A database without 883 and 886 fails here by design, and says so.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
afterAll(() => pool.end());

const NOT_APPLIED = 'migration 883 or 886 is not applied to this database — apply it (isaflow_dev needs Hein\'s OK) or unset DATABASE_URL';
const TABLES = ['company_users', 'company_invitations'];

/** Change one and you change who may grant what: re-review N1b C, then move the pin. */
const PINNED: Record<string, string> = {
  'company_member_actor_role(uuid)': 'b307f99b50ae088c96033164d96c80a3',
  'company_member_role_is_owner(text)': '536560babbf2ad0ead1859707fffe97d',
  'company_users_role_guard()': 'ad237d957ec9972f7e9fd12b84bed1ff',
  'company_invitations_role_guard()': '0c7cf4635edf43e1f8f80566160513a7',
};

const OTHERS = `
  SELECT r.rolname AS who FROM pg_roles r
  WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> $1::oid
    AND NOT (r.rolname = session_user AND pg_has_role(r.oid, $1::oid, 'USAGE'))
  UNION ALL SELECT 'public'`;

describeIfDb('company_users / company_invitations catalogue (R-035 N1b C)', () => {
  it.each(TABLES)('%s: exactly its guard, enabled, BEFORE INSERT OR UPDATE OR DELETE FOR EACH ROW; no rule', async (table) => {
    const { rows } = await pool.query(`
      SELECT t.tgname, t.tgfoid::regprocedure::text AS fn, t.tgenabled, t.tgtype FROM pg_trigger t
      WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal`, [`public.${table}`]);
    expect(rows, NOT_APPLIED).toEqual([{ tgname: `${table}_role_guard`, fn: `${table}_role_guard()`, tgenabled: 'O', tgtype: 31 }]);
    expect((await pool.query('SELECT rulename FROM pg_rewrite WHERE ev_class = $1::regclass', [`public.${table}`])).rows).toEqual([]);
  });

  it('the guards and their role lookup: the bodies 883 and 886 ship, SECURITY INVOKER', async () => {
    const { rows } = await pool.query(`
      SELECT p.oid::regprocedure::text AS fn, md5(p.prosrc) AS md5, p.prosecdef FROM pg_proc p
      WHERE p.oid = ANY (SELECT to_regprocedure('public.' || f) FROM unnest($1::text[]) f) ORDER BY 1`, [Object.keys(PINNED)]);
    expect(Object.fromEntries(rows.map((x) => [x.fn, x.md5])), NOT_APPLIED).toEqual(PINNED);
    expect(rows.every((x) => x.prosecdef === false)).toBe(true);
  });

  it.each(TABLES)('%s: TRUNCATE and TRIGGER held by no role but the owner and migration_admin', async (table) => {
    const { rows: [t] } = await pool.query('SELECT relowner FROM pg_class WHERE oid = $1::regclass', [`public.${table}`]);
    const { rows } = await pool.query(`
      SELECT x.who, priv FROM (${OTHERS}) x, unnest(ARRAY['TRUNCATE','TRIGGER']) priv
      WHERE x.who <> 'migration_admin' AND has_table_privilege(x.who, $2, priv)`, [t.relowner, `public.${table}`]);
    expect(rows, NOT_APPLIED).toEqual([]);
  });

  it.each(TABLES)('%s: written only by the roles the guards judge (and migration_admin)', async (table) => {
    const { rows: [t] } = await pool.query('SELECT relowner FROM pg_class WHERE oid = $1::regclass', [`public.${table}`]);
    const { rows } = await pool.query(`
      SELECT x.who, priv FROM (${OTHERS}) x, unnest(ARRAY['INSERT','UPDATE','DELETE']) priv
      WHERE x.who NOT IN ('app_user', 'platform_admin', 'migration_admin')
        AND (has_table_privilege(x.who, $2, priv) OR (priv <> 'DELETE' AND has_any_column_privilege(x.who, $2, priv)))`,
    [t.relowner, `public.${table}`]);
    expect(rows).toEqual([]);
  });
});
