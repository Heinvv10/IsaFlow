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
 *  - each writer's body and signature are the ones 872 ships (md5 of prosrc,
 *    argument and result types, pinned below) — a CREATE OR REPLACE with a
 *    weaker body fails here until someone re-reviews N1 and updates the pin;
 *  - no other function body names the table in a write: INSERT, UPDATE,
 *    DELETE, TRUNCATE or MERGE, schema-qualified or quoted.
 *
 * LIMIT, by decision (review round 3): a function that builds its statement at
 * run time (`EXECUTE 'UPDATE public.approval_' || 'requests …'`) names no table
 * this can read, and is not chased further. The backstop is behavioural: the
 * forgery, roles, decide, raise and parity suites prove on a disposable
 * fixture that nothing app_user can call writes a row the app would not.
 *
 * A database without 872 fails here by design, and says so: the code needs
 * the migration (isaflow_dev needs Hein's OK to get it).
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

/**
 * The writers exactly as migration 872 creates them. A change to any of these
 * bodies is a change to who may write an approval: re-review N1 (the decide,
 * roles, raise, parity and forgery suites), then update the pin to
 * `SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.<writer>')`.
 */
const PINNED: Record<string, { md5: string; result: string }> = {
  'approval_request_raise(uuid,text,uuid,uuid,text)': { md5: '36fd1aac5e94fe288f62fdbfe0840b20', result: 'SETOF approval_requests' },
  'approval_request_rebind(uuid,uuid,uuid,text)': { md5: '768af4d84ac628234bbdac8ffcae5532', result: 'SETOF approval_requests' },
  'approval_request_lock(uuid,uuid)': { md5: 'ff39a730494c0a39e14e456653f627b3', result: 'void' },
  'approval_request_decide(uuid,uuid,text,text,text,text)': { md5: '9c3c2ce53d36d1872428a484f933f6b9', result: 'SETOF approval_requests' },
};

/** A static write naming the table: INSERT/UPDATE/DELETE/TRUNCATE/MERGE, ONLY, schema-qualified or quoted. */
const WRITE_STATEMENT = String.raw`(insert\s+into|update|delete\s+from|truncate(\s+table)?|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?approval_requests\M`;

const NOT_APPLIED = 'migration 872 is not applied to this database — apply it (isaflow_dev needs Hein\'s OK) or unset DATABASE_URL';

/** Every role that is neither superuser, predefined (pg_*), the object's owner, nor app_user or one of its members; and PUBLIC. */
const OTHERS = `
  SELECT r.rolname AS who FROM pg_roles r
  WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> $1::oid
    AND NOT ($2::bool AND pg_has_role(r.oid, 'app_user', 'MEMBER'))
  UNION ALL SELECT 'public'`;

describeIfDb('approval_requests catalogue (R-035 N1)', () => {
  it('migration 872 is applied', async () => {
    const { rows: [m] } = await pool.query(`
      SELECT to_regprocedure('public.approval_request_decide(uuid,uuid,text,text,text,text)') IS NOT NULL AS applied`);
    expect(m.applied, NOT_APPLIED).toBe(true);
  });

  it.each(WRITERS)('%s: the body and signature 872 ships', async (fn) => {
    const { rows } = await pool.query(`
      SELECT md5(p.prosrc) AS md5, pg_get_function_result(p.oid) AS result
      FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [`public.${fn}`]);
    expect(rows, NOT_APPLIED).toHaveLength(1);
    expect(rows[0], `${fn}: writer body changed — re-review N1 and update the pin`).toEqual(PINNED[fn]);
  });

  it.each(WRITERS)('%s: SECURITY DEFINER, pg_temp last, owner bypasses RLS', async (fn) => {
    const { rows } = await pool.query(`
      SELECT p.prosecdef, (o.rolbypassrls OR o.rolsuper) AS owner_bypasses,
             p.proconfig[array_upper(p.proconfig, 1)] AS last_config
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner WHERE p.oid = to_regprocedure($1)`, [`public.${fn}`]);
    expect(rows, NOT_APPLIED).toHaveLength(1);
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

  it('no function body but the three writers names approval_requests in a write (static SQL only — see LIMIT)', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema')
        AND p.prosrc ~* $1
      ORDER BY 1`, [WRITE_STATEMENT]);
    expect(rows).toEqual([
      { proname: 'approval_request_decide', prosecdef: true },
      { proname: 'approval_request_raise', prosecdef: true },
      { proname: 'approval_request_rebind', prosecdef: true },
    ]);
  });
});
