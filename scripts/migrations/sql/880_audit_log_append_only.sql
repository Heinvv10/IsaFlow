-- 880: R-035 N1b (A) — audit_log is append-only for every role but its owner.
--
-- 872 made approval_requests writable only through SECURITY DEFINER
-- functions, and its decide writes the sole-approver (Q2) audit row. But
-- app_user and platform_admin could still UPDATE, DELETE or TRUNCATE
-- audit_log by raw SQL, so the record of a self-approval could be erased or
-- rewritten after the fact. No app path updates or deletes the table (the one
-- INSERT site is auditTrailService.logAuditOrThrow; the census
-- auditLogAppendOnlyCensus pins that), so this takes those privileges away
-- from every role but the table's owner, and asserts it.
--
-- INSERT stays (every request logs through it), and so does SELECT. A forged
-- EXTRA row therefore remains possible for a role that may insert: that is an
-- accepted limit (Hein, 2026-10-09) — append-only, not authenticated.
--
-- Who still writes: the owner (migration_admin on production, postgres on the
-- classic fixture) and superusers — migrations and the definers' owners —
-- and, through the owner, the deploy role that runs migrations (see 4). A
-- company delete still removes its rows: the FK's ON DELETE CASCADE runs as
-- the table's owner, not as the deleting role.

-- ── 1. Revoke ─────────────────────────────────────────────────────────────
-- Every UPDATE, DELETE, TRUNCATE and TRIGGER privilege of every role but the
-- owner, enumerated from the ACL rather than named — app_user, platform_admin
-- and (on the classic fixture) migration_admin; whatever else an environment
-- granted, PUBLIC included. Column-level UPDATE grants too: one survives a
-- table-level REVOKE. TRIGGER: a trigger another role attached would run
-- inside every insert and could rewrite or drop the row.
DO $$
DECLARE
  v_grantee pg_catalog.text;
  v_col pg_catalog.text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END
    FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE c.oid = 'public.audit_log'::pg_catalog.regclass
      AND a.grantee <> c.relowner
      AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')
  LOOP
    EXECUTE pg_catalog.format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER ON public.audit_log FROM %s CASCADE', v_grantee);
  END LOOP;
  FOR v_grantee, v_col IN
    SELECT DISTINCT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(r.rolname) END,
           pg_catalog.quote_ident(att.attname)
    FROM pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
    LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE att.attrelid = 'public.audit_log'::pg_catalog.regclass AND att.attacl IS NOT NULL
      AND a.privilege_type = 'UPDATE'
  LOOP
    EXECUTE pg_catalog.format('REVOKE UPDATE (%s) ON public.audit_log FROM %s CASCADE', v_col, v_grantee);
  END LOOP;
END $$;

-- ── 2. Assertions: refuse to ship it any other way ────────────────────────
-- The exemption is 872's (#680): on production the deploy role `postgres`
-- is a non-superuser member of the owner `migration_admin` — it must be, to
-- migrate — and holds the owner's rights by inheritance, not by a grant this
-- migration can revoke. Only that one role (session_user) is exempt; ANY
-- OTHER role that inherits the owner, or holds another inherited write path
-- (pg_write_all_data, say), still refuses the migration. has_table_privilege
-- follows direct grants, PUBLIC and inherited membership alike. (A NOINHERIT
-- member that could SET ROLE to the owner is not detected — the pre-existing
-- limit 872 names.)
DO $$
DECLARE
  v_owner pg_catalog.oid := (SELECT c.relowner FROM pg_catalog.pg_class c
                             WHERE c.oid = 'public.audit_log'::pg_catalog.regclass);
  v_role pg_catalog.text;
  v_priv pg_catalog.text;
BEGIN
  FOR v_role IN
    SELECT r.rolname FROM pg_catalog.pg_roles r
    WHERE NOT r.rolsuper AND r.oid <> v_owner AND r.rolname !~ '^pg_'
      AND NOT (r.rolname = session_user AND pg_catalog.pg_has_role(r.oid, v_owner, 'USAGE'))
    UNION ALL SELECT 'public'
  LOOP
    FOREACH v_priv IN ARRAY ARRAY['UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.audit_log', v_priv) THEN
        RAISE EXCEPTION 'migration 880: % still holds % on audit_log', v_role, v_priv;
      END IF;
    END LOOP;
    IF pg_catalog.has_any_column_privilege(v_role, 'public.audit_log', 'UPDATE') THEN
      RAISE EXCEPTION 'migration 880: % still holds column UPDATE on audit_log', v_role;
    END IF;
  END LOOP;
  -- Append-only, not read-only: the roles that log and read keep doing so.
  FOREACH v_role IN ARRAY ARRAY['app_user', 'platform_admin'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'SELECT'] LOOP
      IF NOT pg_catalog.has_table_privilege(v_role, 'public.audit_log', v_priv) THEN
        RAISE EXCEPTION 'migration 880: % lost % on audit_log', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ── 3. The same, by outcome, as each role the runner may become ───────────
-- One savepoint per probe (a caught 42501 still aborts its subtransaction).
-- Every statement matches no row, so a probe that wrongly succeeds changes
-- nothing before the RAISE rolls the migration back. TRUNCATE has no WHERE,
-- so it is asserted above by privilege only, never probed here. The deploy
-- role on production is a member of app_user but not of platform_admin, so
-- the platform_admin probe runs only where the runner can become it (the
-- fixtures); the privilege assertions above cover it everywhere.
DO $$
DECLARE
  v_role pg_catalog.text;
  v_sql pg_catalog.text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['app_user', 'platform_admin'] LOOP
    CONTINUE WHEN NOT pg_catalog.pg_has_role(session_user, v_role, 'MEMBER');
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', v_role);
    FOREACH v_sql IN ARRAY ARRAY[
        'UPDATE public.audit_log SET action = ''approve'' WHERE false',
        'DELETE FROM public.audit_log WHERE false',
        'SELECT 1 FROM public.audit_log WHERE false FOR UPDATE'] LOOP
      BEGIN
        EXECUTE v_sql;
        RAISE EXCEPTION 'migration 880: % may still run: %', v_role, v_sql USING ERRCODE = 'RA999';
      EXCEPTION WHEN insufficient_privilege THEN
        NULL; -- refused, as intended
      END;
    END LOOP;
    -- INSERT is untouched: a statement that inserts nothing still plans and runs.
    EXECUTE 'INSERT INTO public.audit_log (company_id, user_id, action, entity_type, entity_id)
             SELECT NULL, NULL, ''create'', ''probe'', NULL WHERE false';
    RESET ROLE;
  END LOOP;
END $$;
