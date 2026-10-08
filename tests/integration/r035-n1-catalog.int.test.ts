/**
 * R-035 N1 (migration 872), the CATALOGUE half — read-only, so it runs against
 * whatever DATABASE_URL names (a fixture, or isaflow_dev in a local
 * `bun run ci`); it skips only without a database.
 *
 * The unit census (approvalRequestWriteCensus) reads migration TEXT and cannot
 * see a grant built at run time, a weaker redefinition of a writer, or a
 * SECURITY INVOKER switch. This reads what the database actually holds:
 *  - each of the four writers is SECURITY DEFINER, pins search_path with
 *    pg_temp last, is owned by a role that bypasses RLS, and is executable by
 *    app_user and nobody else (the owner, superusers and app_user's own
 *    members aside);
 *  - the helpers are executable by nobody but the owner;
 *  - no role but the table's owner (and superusers) holds INSERT, UPDATE,
 *    DELETE, TRUNCATE or TRIGGER on approval_requests, or a column INSERT /
 *    UPDATE, directly, via PUBLIC or via membership (has_*_privilege follows
 *    all three);
 *  - no other function body writes the table.
 * A database without 872 fails here by design: the code needs the migration.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
afterAll(() => pool.end());

const WRITERS = [
  'approval_request_raise(uuid,text,uuid,uuid,text)',
  'approval_request_rebind(uuid,uuid,uuid,text)',
  'approval_request_lock(uuid,uuid)',
  'approval_request_decide(uuid,uuid,text,text,text,text)',
];

/** Every role that is neither superuser, predefined (pg_*), the object's owner, nor app_user or one of its members; and PUBLIC. */
const OTHERS = `
  SELECT r.rolname AS who FROM pg_roles r
  WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> $1::oid
    AND NOT ($2::bool AND pg_has_role(r.oid, 'app_user', 'MEMBER'))
  UNION ALL SELECT 'public'`;

describeIfDb('approval_requests catalogue (R-035 N1)', () => {
  it.each(WRITERS)('%s: SECURITY DEFINER, pg_temp last, owner bypasses RLS', async (fn) => {
    const { rows } = await pool.query(`
      SELECT p.prosecdef, (o.rolbypassrls OR o.rolsuper) AS owner_bypasses,
             p.proconfig[array_upper(p.proconfig, 1)] AS last_config
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner WHERE p.oid = to_regprocedure($1)`, [`public.${fn}`]);
    expect(rows, `${fn} is missing — is migration 872 applied?`).toHaveLength(1);
    expect(rows[0]).toEqual({ prosecdef: true, owner_bypasses: true, last_config: expect.stringMatching(/^search_path=.*pg_temp$/) });
  });

  it.each(WRITERS)('%s: executable by app_user, and by no other role', async (fn) => {
    const { rows: [p] } = await pool.query('SELECT proowner FROM pg_proc WHERE oid = to_regprocedure($1)', [`public.${fn}`]);
    const { rows } = await pool.query(`SELECT who FROM (${OTHERS}) x WHERE has_function_privilege(who, to_regprocedure($3), 'EXECUTE')`,
      [p.proowner, true, `public.${fn}`]);
    expect(rows).toEqual([]);
    const { rows: [app] } = await pool.query("SELECT has_function_privilege('app_user', to_regprocedure($1), 'EXECUTE') AS ok",
      [`public.${fn}`]);
    expect(app.ok).toBe(true);
  });

  it('the helpers are executable by no role but their owner', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname, x.who FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
        LATERAL (SELECT r.rolname AS who FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> p.proowner
                 UNION ALL SELECT 'public') x
      WHERE n.nspname = 'public' AND (p.proname LIKE 'approval\\_request\\_%' OR p.proname = 'approval_actor_rank')
        AND p.proname NOT IN ('approval_request_insert_guard', 'approval_request_raise', 'approval_request_rebind',
                              'approval_request_lock', 'approval_request_decide')
        AND has_function_privilege(x.who, p.oid, 'EXECUTE')
      ORDER BY 1, 2`);
    expect(rows).toEqual([]);
  });

  it('no role but the owner may write, truncate or trigger approval_requests — directly, via PUBLIC or via membership', async () => {
    const { rows: [t] } = await pool.query("SELECT relowner FROM pg_class WHERE oid = 'public.approval_requests'::regclass");
    const { rows } = await pool.query(`
      SELECT x.who, priv FROM (${OTHERS}) x, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER']) priv
      WHERE has_table_privilege(x.who, 'public.approval_requests', priv)
      UNION ALL
      SELECT x.who, 'column ' || priv FROM (${OTHERS}) x, unnest(ARRAY['INSERT','UPDATE']) priv
      WHERE has_any_column_privilege(x.who, 'public.approval_requests', priv)
      UNION ALL
      SELECT 'app_user', priv FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER']) priv
      WHERE has_table_privilege('app_user', 'public.approval_requests', priv)`, [t.relowner, false]);
    expect(rows).toEqual([]);
  });

  it('no function body but the three writers writes approval_requests', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND p.prosrc ~* '(insert\\s+into|update|delete\\s+from|truncate)\\s+(only\\s+)?(public\\.)?approval_requests\\M'
      ORDER BY 1`);
    expect(rows).toEqual([
      { proname: 'approval_request_decide', prosecdef: true },
      { proname: 'approval_request_raise', prosecdef: true },
      { proname: 'approval_request_rebind', prosecdef: true },
    ]);
  });
});
