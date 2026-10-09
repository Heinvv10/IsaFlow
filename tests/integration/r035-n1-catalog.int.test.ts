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
 *  - so is every function a writer calls, directly or transitively (872's
 *    helpers and the older rank, rule, gate-amount, author, roster and claims
 *    helpers from 348/708/712/862/865/867/869), plus the insert-guard trigger
 *    a raise fires — with its SECURITY DEFINER flag and volatility — and the
 *    pinned set is checked to be closed over the calls in those bodies;
 *  - no other function body names the table in a write: INSERT, UPDATE,
 *    DELETE, TRUNCATE or MERGE, schema-qualified or quoted;
 *  - the triggers on approval_requests are exactly the 862 insert guard
 *    (BEFORE INSERT, FOR EACH ROW, enabled), and audit_log has none — a
 *    trigger rewriting NEW runs inside the definers' writes and calls nothing
 *    the closure check would see;
 *  - neither table carries a rewrite RULE (an ON INSERT … DO INSTEAD NOTHING
 *    on audit_log would swallow the Q2 row; one on approval_requests could
 *    redirect or add to the definers' writes).
 *
 * EXCEPTION: approval_document_digest is NOT body-pinned. It is redefined by
 * design on other branches (873 dimensions, 874 line revenue) as documents
 * gain hashed columns, and the decide re-reads it live. A legitimate change
 * (more hashed columns) only makes approvals stale; a weakened digest (fewer
 * columns, or a constant) would WIDEN what an approval vouches for, and passes
 * this suite — review round 5 ran such a constant digest here: 46/46 green.
 * The controls are the review of each migration that redefines it, those
 * migrations' own "existing digests unchanged" RAISE guards, and the digest
 * behaviour suites on the disposable fixture (r035-n1-decide, -parity, -raise,
 * r035-approval-digest, r035-pr3-digest), which went red on that constant
 * digest. Its shape is asserted here: not DEFINER, STABLE, pg_temp last, text
 * result, owner bypasses RLS.
 *
 * LIMIT, by decision (review round 3): a function that builds its statement at
 * run time (`EXECUTE 'UPDATE public.approval_' || 'requests …'`) names no table
 * this can read, and is not chased further. For the four writers and their
 * helpers the body pins above plus the behaviour suites on the disposable fixture (forgery,
 * roles, decide, raise, parity) are the backstop; a NEW function that writes
 * the table through run-time SQL is detected by no test — code review of the
 * migration that adds it is the control.
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

/**
 * Every function the four writers call, transitively, as the fixture holds it
 * after 348..872. Same rule as PINNED: a change here changes who may write an
 * approval — re-review N1, then update the pin.
 */
type HelperPin = { md5: string; result: string; definer: boolean; volatility: 'i' | 's' | 'v' };
const HELPERS: Record<string, HelperPin> = {
  'app.current_company_id()': { md5: '237fea0ba8279d7eefd00b950e1b31ae', result: 'uuid', definer: false, volatility: 's' },
  'auth.uid()': { md5: 'b990bc367fb57ea28ad65cf7472f9f9c', result: 'text', definer: false, volatility: 's' },
  'public.approval_actor_rank(text)': { md5: '6494ea06c769c6dcb1aab6c39defa9d0', result: 'integer', definer: false, volatility: 'i' },
  'public.approval_add_author(uuid[],uuid)': { md5: '2341bd157a56094ecfc93838b4913fce', result: 'uuid[]', definer: false, volatility: 'i' },
  'public.approval_company_other_members(uuid,text)': { md5: '78b1dcde283ba12b6fe2051ad68952fc',
    result: 'TABLE(user_id text, role text, is_active boolean, status text, suspended_at timestamp with time zone)', definer: true, volatility: 's' },
  'public.approval_credit_note_gate_amount(numeric,numeric,numeric)': { md5: '984ecd4536dc94245da9b5c14ac440f3', result: 'numeric', definer: false, volatility: 'i' },
  'public.approval_customer_invoice_gate_amount(numeric,numeric)': { md5: '1283c834d9495799241fbcc89655329f', result: 'numeric', definer: false, volatility: 'i' },
  'public.approval_document_authors(uuid,text,uuid)': { md5: 'be4e8084971b533e65a8abd2579f7d12', result: 'uuid[]', definer: false, volatility: 's' },
  'public.approval_manual_journal_gate_amount(uuid,uuid)': { md5: 'bfddd2d79c4775e6d22ea7a03d3bb7be', result: 'numeric', definer: false, volatility: 's' },
  'public.approval_payment_batch_gate_amount(uuid,uuid)': { md5: '005d7606d5694d15c8606d0ded8b3eaa', result: 'numeric', definer: false, volatility: 's' },
  'public.approval_payment_batch_strictest_rank(uuid,uuid)': { md5: 'e29c6e85c5418e5f0d200dd799078e9b', result: 'integer', definer: false, volatility: 's' },
  'public.approval_request_assert_caller(uuid,text,boolean)': { md5: 'e81e87faed16844642167194a17f96d3', result: 'void', definer: false, volatility: 's' },
  'public.approval_request_assert_write_role(uuid,text,boolean)': { md5: '678e0f81e3eb0e48eaeab832a2eef790', result: 'void', definer: false, volatility: 's' },
  'public.approval_request_bindable_rule(uuid,text,uuid,numeric,uuid)': { md5: 'abddb5e6c6ece5fa11fb10c1f9398af5', result: 'approval_rules', definer: false, volatility: 's' },
  'public.approval_request_caller_bypasses()': { md5: '6cd0733f7baaa32803c10537f2398b4f', result: 'boolean', definer: false, volatility: 's' },
  'public.approval_request_caller_sees(uuid)': { md5: 'beb6f8e6bdd2e48e1ea318e2e438efb0', result: 'boolean', definer: false, volatility: 's' },
  'public.approval_request_document_facts(uuid,text,uuid)': { md5: '61befd6901fc2480193afc20c7ac9826',
    result: 'TABLE(amount numeric, reference text, digest text)', definer: false, volatility: 's' },
  'public.approval_request_insert_guard()': { md5: 'a572e6c1ef423d1c40eb9b55c8fe9eec', result: 'trigger', definer: false, volatility: 'v' },
  'public.approval_request_may_write(text)': { md5: 'a2f0f6a08921d88d29a6747d533e4ac5', result: 'boolean', definer: false, volatility: 'i' },
  'public.approval_request_session_actor()': { md5: '3e0c2b78d80e2f1d15cfd6bc0127b369', result: 'text', definer: false, volatility: 's' },
  'public.approval_request_subject()': { md5: '53896f0197122cf11e87851de0078f6e', result: 'uuid', definer: false, volatility: 's' },
  'public.approval_required_rank(text)': { md5: 'dc87c183bf09ed8a22295c90b1ce9016', result: 'integer', definer: false, volatility: 'i' },
  'public.approval_roster_snapshot(uuid,text)': { md5: '879310d001e3e8d4882de532ab1499a0', result: 'jsonb', definer: false, volatility: 's' },
  'public.approval_rule_strictest_rank(uuid,text,numeric)': { md5: '23b7009e36d36f7fde8dc3fd9f6d2f44', result: 'integer', definer: false, volatility: 's' },
  'public.approval_supplier_invoice_gate_amount(numeric,numeric)': { md5: 'e1e7e46e7188788259f51638f9aa7536', result: 'numeric', definer: false, volatility: 'i' },
  'public.approval_supplier_payment_authors(uuid,uuid)': { md5: 'cb2b3e8246a8c45b33f116db838c93a2', result: 'uuid[]', definer: false, volatility: 's' },
  'public.approval_supplier_payment_content(uuid,uuid)': { md5: 'ba7874b8cc8b22a6bef5757e96b6ff26', result: 'jsonb', definer: false, volatility: 's' },
  'public.approval_supplier_payment_gate_amount(numeric)': { md5: 'd4cf7981bd0db4cdb514891f17d6232a', result: 'numeric', definer: false, volatility: 'i' },
};
/** Redefined on purpose elsewhere (see EXCEPTION): shape only. */
const SHAPE_ONLY = 'public.approval_document_digest(uuid,text,uuid)';

const NOT_APPLIED = 'migration 872 is not applied to this database — apply it (isaflow_dev needs Hein\'s OK) or unset DATABASE_URL';

/** Every role that is neither superuser, predefined (pg_*), the object's owner, nor app_user or one of its members; and PUBLIC. */
// The session's own role, when it is a member of the owner, holds the owner's
// rights by inheritance — on production the deploy/login role `postgres` is a
// member of the owner `migration_admin` — and is exempt like the owner and
// superusers, exactly as migration 872's own assertions exempt it (the N1
// boundary). Any OTHER member of the owner is reported.
const OTHERS = `
  SELECT r.rolname AS who FROM pg_roles r
  WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> $1::oid
    AND NOT (r.rolname = session_user AND pg_has_role(r.oid, $1::oid, 'USAGE'))
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

  it.each(Object.keys(HELPERS))('%s: the body, signature and attributes the writers were reviewed against', async (fn) => {
    const { rows } = await pool.query(`
      SELECT md5(p.prosrc) AS md5, pg_get_function_result(p.oid) AS result, p.prosecdef AS definer, p.provolatile AS volatility
      FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [fn]);
    expect(rows, `${fn} is missing — ${NOT_APPLIED}`).toHaveLength(1);
    expect(rows[0], `${fn}: helper body changed — re-review N1 and update the pin`).toEqual(HELPERS[fn]);
  });

  it(`${SHAPE_ONLY}: not pinned by body (changed by design elsewhere), but its shape holds`, async () => {
    const { rows } = await pool.query(`
      SELECT pg_get_function_result(p.oid) AS result, p.prosecdef AS definer, p.provolatile AS volatility,
             p.proconfig[array_upper(p.proconfig, 1)] AS last_config, (o.rolbypassrls OR o.rolsuper) AS owner_bypasses
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner WHERE p.oid = to_regprocedure($1)`, [SHAPE_ONLY]);
    expect(rows, NOT_APPLIED).toHaveLength(1);
    expect(rows[0]).toEqual({ result: 'text', definer: false, volatility: 's',
      last_config: expect.stringMatching(/^search_path=.*pg_temp$/), owner_bypasses: true });
  });

  it('the triggers on approval_requests are exactly the insert guard, enabled, BEFORE INSERT FOR EACH ROW; audit_log has none', async () => {
    const { rows } = await pool.query(`
      SELECT t.tgrelid::regclass::text AS tbl, t.tgname, t.tgfoid::regprocedure::text AS fn, t.tgenabled, t.tgtype
      FROM pg_trigger t
      WHERE t.tgrelid IN ('public.approval_requests'::regclass, 'public.audit_log'::regclass) AND NOT t.tgisinternal
      ORDER BY 1, 2`);
    // tgtype 7 = ROW (1) | BEFORE (2) | INSERT (4); tgenabled 'O' = fires in origin (normal) mode.
    expect(rows, 'a trigger on approval_requests or audit_log changed — re-review N1').toEqual([
      { tbl: 'approval_requests', tgname: 'trg_approval_request_insert_guard', fn: 'approval_request_insert_guard()',
        tgenabled: 'O', tgtype: 7 },
    ]);
  });

  it('no rewrite rule on approval_requests or audit_log', async () => {
    const { rows } = await pool.query(`
      SELECT ev_class::regclass::text AS tbl, rulename FROM pg_rewrite
      WHERE ev_class IN ('public.approval_requests'::regclass, 'public.audit_log'::regclass) ORDER BY 1, 2`);
    expect(rows, 'a rewrite rule on approval_requests or audit_log — re-review N1').toEqual([]);
  });

  it('the pinned set is closed: every function a writer or pinned helper calls is pinned (or the digest)', async () => {
    const pinned = [...WRITERS.map((w) => `public.${w}`), ...Object.keys(HELPERS), SHAPE_ONLY];
    const { rows } = await pool.query(`
      WITH pinned AS (SELECT to_regprocedure(x) AS oid FROM unnest($1::text[]) x),
      src AS (SELECT p.oid, p.prosrc FROM pg_proc p JOIN pinned ON pinned.oid = p.oid WHERE p.oid <> to_regprocedure($2))
      SELECT DISTINCT q.oid::regprocedure::text AS callee
      FROM src, pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
      WHERE n.nspname IN ('public', 'auth', 'app') AND q.oid NOT IN (SELECT oid FROM pinned)
        -- extension members (pgvector's sum, …) are the extension's, not ours
        AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = q.oid AND d.deptype = 'e')
        AND src.prosrc ~* ('\\m' || q.proname || '\\s*\\(')
      ORDER BY 1`, [pinned, SHAPE_ONLY]);
    expect(rows, 'a writer or helper calls an unpinned function — pin it, then re-review N1').toEqual([]);
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
                   AND NOT (r.rolname = session_user AND pg_has_role(r.oid, p.proowner, 'USAGE'))
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
