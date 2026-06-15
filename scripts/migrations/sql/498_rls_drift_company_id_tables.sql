-- scripts/migrations/sql/498_rls_drift_company_id_tables.sql
-- Pentest re-run (2026-06-15): RLS drift remediation.
--
-- Migration 348 enabled tenant_isolation RLS on every public.* table carrying a
-- `company_id` column. Tables created in LATER migrations drifted out of coverage
-- in two ways, both of which the rls-policy-coverage integration test flags:
--   (1) ~68 tables had RLS fully DISABLED (no ENABLE, no policy);
--   (2) 6 tables had RLS ENABLEd with their own policy but were missing FORCE
--       (so the table owner role would bypass them).
-- This migration heals BOTH. It self-selects every company_id table that is not
-- yet {rowsecurity AND forcerowsecurity AND has-a-policy}, so it is idempotent and
-- only touches non-compliant tables, and auto-heals any future drift if re-run.
--
-- WHY RLS HERE IS DEFENCE-IN-DEPTH (and therefore safe to add broadly):
--   The runtime DB pool role is BYPASSRLS. These policies (FOR ALL TO app_user)
--   only apply on the withAuth path, which does `SET LOCAL ROLE app_user`. Non-
--   withAuth paths — cron jobs, the customer portal, capture/extension ingest, and
--   the bureau read-services (see src/modules/bureau/services/.claude.md: "run on
--   the RLS-bypassing pool … isolation rests ENTIRELY on company_id = ANY(...)") —
--   run as the BYPASSRLS pool role and are UNAFFECTED. The primary tenant guard
--   remains the explicit `AND company_id = …` filter in every query; this adds a
--   second, fail-closed barrier underneath it for the authenticated app path.
--
-- WITH CHECK — MEMBERSHIP-BASED (differs deliberately from 348):
--   348 uses `WITH CHECK (company_id = app.current_company_id())` — writes must
--   target the ACTIVE company. A few of the drifted tables are written on the
--   withAuth path with a company_id that is one of the caller's companies yet not
--   necessarily the active one. To guarantee this migration can NEVER block a
--   legitimate write while staying fail-closed against cross-tenant writes, the
--   WITH CHECK below requires only that the row's company_id is one the caller is
--   a MEMBER of — the same predicate as USING. Active-company scoping is still
--   enforced at the application layer by the explicit query filters. Safe-by-
--   construction. (Tables that ALREADY have a policy keep it untouched — we only
--   add FORCE to them; we never OR a second permissive policy over a stricter one.)
--
-- Helpers auth.uid() and app.current_company_id() are defined in migration 348.
-- companies / company_users / company_invitations are excluded: they carry their
-- own special-case policies in 348.

DO $$
DECLARE
  r record;
  n_policy int := 0;
  n_force  int := 0;
BEGIN
  FOR r IN
    SELECT pc.relname AS table_name,
           EXISTS (
             SELECT 1 FROM pg_policies pp
             WHERE pp.schemaname = 'public' AND pp.tablename = pc.relname
           ) AS has_policy
    FROM (
      SELECT DISTINCT col.table_name
      FROM information_schema.columns col
      JOIN information_schema.tables tb USING (table_schema, table_name)
      WHERE col.column_name = 'company_id'
        AND col.table_schema = 'public'
        AND tb.table_type = 'BASE TABLE'
        AND col.table_name NOT IN ('companies', 'company_users', 'company_invitations')
    ) ct
    JOIN pg_class pc ON pc.relname = ct.table_name
                     AND pc.relnamespace = 'public'::regnamespace
    WHERE pc.relkind = 'r'
      AND (
        NOT pc.relrowsecurity
        OR NOT pc.relforcerowsecurity
        OR NOT EXISTS (
          SELECT 1 FROM pg_policies pp
          WHERE pp.schemaname = 'public' AND pp.tablename = pc.relname
        )
      )
    ORDER BY pc.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    n_force := n_force + 1;

    -- Only install tenant_isolation where the table has NO policy yet, so we never
    -- OR a permissive policy over a table's existing (possibly stricter) one.
    IF NOT r.has_policy THEN
      EXECUTE format($p$
        CREATE POLICY tenant_isolation ON public.%1$I
          FOR ALL TO app_user
          USING (company_id IN (
            SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
          ))
          WITH CHECK (company_id IN (
            SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
          ));
      $p$, r.table_name);
      n_policy := n_policy + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'mig 498: healed % company_id table(s) (% new tenant_isolation policy, % enable+force)', n_force, n_policy, n_force;
END $$;
