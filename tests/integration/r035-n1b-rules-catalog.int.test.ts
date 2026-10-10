/**
 * R-035 N1b (B, migration 881), the CATALOGUE half — read-only, so it runs
 * against whatever DATABASE_URL names (a fixture, or isaflow_dev in a local
 * `bun run ci`); it skips only without a database.
 *
 *  - the five writers (approval_rule_lock/_create/_update/_delete,
 *    approval_enforcement_set) are SECURITY DEFINER, pin search_path with
 *    pg_temp last, are owned by a role that bypasses RLS, and are executable
 *    by app_user and nobody else (the owner, superusers and the session's own
 *    role through them aside);
 *  - every helper is executable by its owner only;
 *  - no role but each table's owner holds INSERT, UPDATE, DELETE, TRUNCATE or
 *    TRIGGER on approval_rules or approval_enforcement, or a column INSERT /
 *    UPDATE — directly, via PUBLIC or via membership;
 *  - every writer and every function it calls is the body 881 ships (md5 of
 *    prosrc), the pinned set closed over the calls in those bodies — a weaker
 *    CREATE OR REPLACE fails here until N1b is re-reviewed and the pin moved;
 *  - no other function body names either table in a static write, and neither
 *    table carries a trigger or a rewrite rule but 890's change-history
 *    capture (AFTER, writes only entity_changes, returns NULL);
 *  - no view over either table, at any depth, lets another role write through
 *    its owner (an auto-updatable view checks its OWNER's rights: adversarial
 *    review of PR #690, R3-1; as 880 for audit_log).
 *
 * LIMIT (as r035-n1-catalog): a function that builds its write at run time is
 * not seen; migration review is the control. A database without 881 fails
 * here by design, and says so.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
const describeIfDb = url && !url.includes('dummy') ? describe : describe.skip;
const pool = new Pool({ connectionString: url });
afterAll(() => pool.end());

const NOT_APPLIED = 'migration 881 is not applied to this database — apply it (isaflow_dev needs Hein\'s OK) or unset DATABASE_URL';
const TABLES = ['approval_rules', 'approval_enforcement'];
const BODY_CHANGED = 'a pinned body differs from the one 881 ships — re-review N1b B, then move the pin (or 881 is not applied)';

const WRITERS = [
  'public.approval_rule_lock(uuid,uuid,text)',
  'public.approval_rule_create(uuid,text,text,text,text,text,numeric,text)',
  'public.approval_rule_update(uuid,uuid,text,text,text,text,numeric,text,boolean)',
  'public.approval_rule_delete(uuid,uuid,text)',
  'public.approval_enforcement_set(uuid,text,boolean,text)',
];

/** Every helper 881 creates: EXECUTE for their owner only. */
const HELPERS_881 = [
  'public.approval_rule_assert_caller(uuid,text)', 'public.approval_rule_actor_role(uuid,text)',
  'public.approval_rule_may_weaken(text,text)', 'public.approval_rule_js_trim(text)', 'public.approval_rule_name_ok(text)',
  'public.approval_rule_amount_ok(numeric)', 'public.approval_rule_assert_input(text,text,text,text,numeric)',
  'public.approval_rule_assert_may_demand(text,text)',
  'public.approval_rule_weakens(approval_rules,boolean,text,boolean,text,numeric)',
  'public.approval_rule_audit_fields(approval_rules,approval_rules)', 'public.approval_rule_actor_email()',
  'public.approval_rule_audit(uuid,text,text,text,uuid,approval_rules,approval_rules)',
  'public.approval_enforcement_strictest_role(uuid,text)', 'public.approval_enforcement_bank_verifier_role(uuid)',
  'public.approval_enforcement_bank_baseline(uuid,text)',
];

/**
 * md5(prosrc) of every writer and every function they call, transitively, as
 * 881 (and 862/872 for the shared rank and session helpers; 885 for
 * approval_enforcement_set's bank_rule branch and the 877 functions it calls) ship them. A change
 * to any is a change to who may write a rule or a switch: re-review N1b B, then
 * `SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('<fn>')`.
 */
const PINNED: Record<string, string> = {
  'app.current_company_id()': '237fea0ba8279d7eefd00b950e1b31ae',
  'auth.uid()': 'b990bc367fb57ea28ad65cf7472f9f9c',
  'public.approval_actor_rank(text)': '6494ea06c769c6dcb1aab6c39defa9d0',
  'public.approval_enforcement_bank_baseline(uuid,text)': '0305ef1c9e4e6b6b1e979f790a880b9f',
  'public.approval_enforcement_bank_verifier_role(uuid)': '9ba996ca3a9a60bf035a3ac9c523175f',
  'public.approval_enforcement_set(uuid,text,boolean,text)': '816cf0c6e71f862b4c617003939ff5c7', // 885: + the bank_rule branch
  'public.approval_enforcement_strictest_role(uuid,text)': 'cd21513f46566972f73e50acbf4e8d11',
  'public.approval_request_assert_write_role(uuid,text,boolean)': '678e0f81e3eb0e48eaeab832a2eef790',
  'public.approval_request_caller_bypasses()': '6cd0733f7baaa32803c10537f2398b4f',
  'public.approval_request_may_write(text)': 'a2f0f6a08921d88d29a6747d533e4ac5',
  'public.approval_request_session_actor()': '3e0c2b78d80e2f1d15cfd6bc0127b369',
  'public.approval_request_subject()': '53896f0197122cf11e87851de0078f6e',
  'public.approval_required_rank(text)': 'dc87c183bf09ed8a22295c90b1ce9016',
  'public.approval_rule_actor_email()': '686115d13b4fdd66da5b8602d18b9c79',
  'public.approval_rule_actor_role(uuid,text)': '174a436cd947e802cc4fc416d32220f4',
  'public.approval_rule_amount_ok(numeric)': '536f56e2522ca042ca7e683b998a8932',
  'public.approval_rule_assert_caller(uuid,text)': '838c84d477ce66ce4db038f9bd4c9d96',
  'public.approval_rule_assert_input(text,text,text,text,numeric)': '5805e57a3b806819709d9860fb0bd4d7',
  'public.approval_rule_assert_may_demand(text,text)': '9cac53886d7951b2db665f13cdd052ca',
  'public.approval_rule_audit(uuid,text,text,text,uuid,approval_rules,approval_rules)': 'fd7c9ca09f372b7a0989101ad8f6c856',
  'public.approval_rule_audit_fields(approval_rules,approval_rules)': '47aec3b7f1c5c92e09392bbae1bcd7d8',
  'public.approval_rule_create(uuid,text,text,text,text,text,numeric,text)': 'aabe713deee510811b8fe43139045ed1',
  'public.approval_rule_delete(uuid,uuid,text)': 'deb4ec7b90e82c67309889b8aa365cab',
  'public.approval_rule_js_trim(text)': 'dc94b92db5d007959c4c414b069ebc3b',
  'public.approval_rule_lock(uuid,uuid,text)': '84c06b00c4417ea9a6155ace3c465c7e',
  'public.approval_rule_may_weaken(text,text)': '2dfca83f178954c5677a50da4bd7dbd9',
  'public.approval_rule_name_ok(text)': '90e6c6089fe536bba6265e34a09e4278',
  'public.approval_rule_update(uuid,uuid,text,text,text,text,numeric,text,boolean)': 'bbcc0df79bc759c200ab0c511122db4f',
  'public.approval_rule_weakens(approval_rules,boolean,text,boolean,text,numeric)': '07e2481d2262f043a5972a7ff1f0a52f',
  // 877's ladder and approver role, reached through 885's bank_rule branch.
  'public.bank_control_rank(text)': 'e98c203ea62491b6a033a515b5fd0d6e',
  'public.bank_rule_approver_role(uuid)': '31bc64f8ec0e09ac25bcc574ebd8b8c2',
  'public.supplier_bank_details_present(text,text,text,text,text)': '76863faedf34b260e5df523dfd1457d3',
  'public.supplier_bank_fingerprint(text,text,text,text,text)': '5b38c47e7eea7f2c4b7cff32ec453169',
};

/** A static write naming either table. */
const WRITE_STATEMENT = String.raw`(insert\s+into|update|delete\s+from|truncate(\s+table)?|merge\s+into)\s+(only\s+)?("?public"?\s*\.\s*)?"?approval_(rules|enforcement)\M`;

const OTHERS = `
  SELECT r.rolname AS who FROM pg_roles r
  WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> $1::oid
    AND NOT (r.rolname = session_user AND pg_has_role(r.oid, $1::oid, 'USAGE'))
    AND NOT ($2::bool AND (r.rolname = 'app_user' OR (r.rolname = session_user AND pg_has_role(r.oid, 'app_user', 'USAGE'))))
  UNION ALL SELECT 'public'`;

describeIfDb('approval_rules / approval_enforcement catalogue (R-035 N1b B)', () => {
  it.each(WRITERS)('%s: SECURITY DEFINER, pg_temp last, owner bypasses RLS', async (fn) => {
    const { rows } = await pool.query(`
      SELECT p.prosecdef, (o.rolbypassrls OR o.rolsuper) AS owner_bypasses,
             p.proconfig[array_upper(p.proconfig, 1)] AS last_config
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner WHERE p.oid = to_regprocedure($1)`, [fn]);
    expect(rows, NOT_APPLIED).toHaveLength(1);
    expect(rows[0]).toEqual({ prosecdef: true, owner_bypasses: true, last_config: expect.stringMatching(/^search_path=.*pg_temp$/) });
  });

  it.each(WRITERS)('%s: executable by app_user, and by no other role', async (fn) => {
    const { rows: [p] } = await pool.query('SELECT proowner FROM pg_proc WHERE oid = to_regprocedure($1)', [fn]);
    expect(p, NOT_APPLIED).toBeDefined();
    const { rows } = await pool.query(`SELECT who FROM (${OTHERS}) x WHERE has_function_privilege(who, to_regprocedure($3), 'EXECUTE')`,
      [p.proowner, true, fn]);
    expect(rows).toEqual([]);
    expect((await pool.query("SELECT has_function_privilege('app_user', to_regprocedure($1), 'EXECUTE') AS ok", [fn])).rows[0].ok).toBe(true);
  });

  it('the helpers 881 adds are executable by no role but their owner', async () => {
    const { rows } = await pool.query(`
      SELECT p.oid::regprocedure::text AS fn, x.who FROM pg_proc p,
        LATERAL (SELECT r.rolname AS who FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> p.proowner
                   AND NOT (r.rolname = session_user AND pg_has_role(r.oid, p.proowner, 'USAGE'))
                 UNION ALL SELECT 'public') x
      WHERE p.oid = ANY (SELECT to_regprocedure(h) FROM unnest($1::text[]) h)
        AND has_function_privilege(x.who, p.oid, 'EXECUTE')
      ORDER BY 1, 2`, [HELPERS_881]);
    expect(rows).toEqual([]);
    const { rows: [n] } = await pool.query('SELECT count(to_regprocedure(h))::INT AS n FROM unnest($1::text[]) h', [HELPERS_881]);
    expect(n.n, NOT_APPLIED).toBe(HELPERS_881.length);
  });

  it('the older functions that only share the prefix stay executable by app_user (the app matches rules through them)', async () => {
    const { rows } = await pool.query(`
      SELECT f FROM unnest($1::text[]) f WHERE NOT has_function_privilege('app_user', to_regprocedure(f), 'EXECUTE')`,
    [['public.approval_rule_matches(uuid,text,numeric)', 'public.approval_rule_strictest_rank(uuid,text,numeric)']]);
    expect(rows).toEqual([]);
  });

  it.each(TABLES)('no role but the owner may write, truncate or trigger %s — directly, via PUBLIC or via membership', async (table) => {
    const { rows: [t] } = await pool.query('SELECT relowner FROM pg_class WHERE oid = $1::regclass', [`public.${table}`]);
    const { rows } = await pool.query(`
      SELECT x.who, priv FROM (${OTHERS}) x, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER']) priv
      WHERE has_table_privilege(x.who, $3, priv)
      UNION ALL
      SELECT x.who, 'column ' || priv FROM (${OTHERS}) x, unnest(ARRAY['INSERT','UPDATE']) priv
      WHERE has_any_column_privilege(x.who, $3, priv)
      UNION ALL
      SELECT 'app_user', priv FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER']) priv
      WHERE has_table_privilege('app_user', $3, priv)`, [t.relowner, false, `public.${table}`]);
    expect(rows, NOT_APPLIED).toEqual([]);
    for (const who of ['app_user', 'platform_admin']) {
      expect((await pool.query('SELECT has_table_privilege($1, $2, \'SELECT\') AS ok', [who, `public.${table}`])).rows[0].ok).toBe(true);
    }
  });

  it('every writer and every function it calls is the body 881 ships, and the pinned set is closed', async () => {
    const { rows } = await pool.query(`
      WITH RECURSIVE reach(oid) AS (
        SELECT to_regprocedure(w) FROM unnest($1::text[]) w
        UNION
        SELECT q.oid FROM reach JOIN pg_proc p ON p.oid = reach.oid, pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
        WHERE n.nspname IN ('public', 'auth', 'app') AND q.oid <> p.oid
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = q.oid AND d.deptype = 'e')
          AND p.prosrc ~* ('\\m' || q.proname || '\\s*\\(')
      )
      SELECT n.nspname || '.' || (p.oid::regprocedure)::text AS fn, md5(p.prosrc) AS md5
      FROM reach JOIN pg_proc p ON p.oid = reach.oid JOIN pg_namespace n ON n.oid = p.pronamespace
      ORDER BY 1`, [WRITERS]);
    expect(Object.fromEntries(rows.map((x) => [x.fn.replace(/^(\w+)\.\1\./, '$1.'), x.md5])), BODY_CHANGED).toEqual(PINNED);
  });

  it('no function body but the four writers names either table in a write (static SQL only — see LIMIT)', async () => {
    const { rows } = await pool.query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prosrc ~* $1
      ORDER BY 1`, [WRITE_STATEMENT]);
    expect(rows.map((x) => x.proname)).toEqual([
      'approval_enforcement_set', 'approval_rule_create', 'approval_rule_delete', 'approval_rule_update']);
  });

  // Since 890 each table carries exactly the change-history capture: AFTER
  // INSERT OR UPDATE OR DELETE FOR EACH ROW (tgtype 29), ENABLE ALWAYS, its
  // function the SECURITY DEFINER that writes only entity_changes and returns
  // NULL — it cannot change the row a definer wrote. Nothing else.
  it('neither table carries a trigger or a rewrite rule but 890\'s change-history capture', async () => {
    const { rows } = await pool.query(`
      SELECT tgrelid::regclass::text AS t, tgname AS name, tgfoid::regprocedure::text AS fn, tgenabled AS enabled, tgtype AS type
      FROM pg_trigger
      WHERE tgrelid = ANY ($1::regclass[]) AND NOT tgisinternal
      UNION ALL
      SELECT ev_class::regclass::text, rulename, NULL, NULL, NULL FROM pg_rewrite WHERE ev_class = ANY ($1::regclass[])
      ORDER BY 1`,
    [TABLES.map((t) => `public.${t}`)]);
    expect(rows).toEqual([...TABLES].sort().map((t) => (
      { t, name: 'entity_change_capture', fn: 'entity_change_capture()', enabled: 'A', type: 29 })));
  });

  it.each(TABLES)('no view over %s — at any depth — lets another role write through its owner', async (table) => {
    const { rows: [t] } = await pool.query('SELECT relowner FROM pg_class WHERE oid = $1::regclass', [`public.${table}`]);
    const { rows } = await pool.query(`
      WITH RECURSIVE chain(oid) AS (
        SELECT w.ev_class FROM pg_depend d JOIN pg_rewrite w ON w.oid = d.objid
        WHERE d.classid = 'pg_rewrite'::regclass AND d.refobjid = $3::regclass AND w.ev_class <> d.refobjid
        UNION
        SELECT w.ev_class FROM chain JOIN pg_depend d ON d.refobjid = chain.oid JOIN pg_rewrite w ON w.oid = d.objid
        WHERE d.classid = 'pg_rewrite'::regclass AND w.ev_class <> chain.oid)
      SELECT v.oid::regclass::text AS view, x.who, p.priv
      FROM chain JOIN pg_class v ON v.oid = chain.oid, (${OTHERS}) x, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
      WHERE NOT EXISTS (SELECT 1 FROM unnest(v.reloptions) o WHERE o ~* '^security_invoker=(true|on|yes|1)$')
        AND has_table_privilege(v.relowner, $3::regclass, p.priv)
        AND x.who <> (SELECT rolname FROM pg_roles WHERE oid = v.relowner)
        AND (has_table_privilege(x.who, v.oid, p.priv)
             OR (p.priv IN ('INSERT', 'UPDATE') AND has_any_column_privilege(x.who, v.oid, p.priv)))
      ORDER BY 1, 2, 3`, [t.relowner, false, `public.${table}`]);
    expect(rows).toEqual([]);
  });
});
