-- 893: the audit tables' read policy is evaluated once per query, not once per row.
--
--   891's policies call public.audit_snapshot_reader(company_id) for every row. That function cannot be inlined (it
--   carries SET search_path), so on Velocity Fibre's first snapshot (2026-10-15: 90,965 lines, 37,054 journals) the
--   reader ran 128k times: about 70 µs a row, 11 s of the 17.6 s a verify took, and on a loaded box the lines read
--   ran past the database's 95 s statement_timeout and the verify failed.
--
--   The reader is true only for the session's own company (its first clause is p_company_id =
--   app.current_company_id()), so for every row
--     audit_snapshot_reader(company_id)
--       = company_id = app.current_company_id() AND audit_snapshot_reader(app.current_company_id())
--   and the right-hand side is the same rows. Written with both calls as uncorrelated sub-selects they become
--   InitPlans: evaluated once per query, and the company_id comparison can use an index. No row is visible that was
--   not before, and none is hidden that was visible (a NULL company GUC still shows nothing).
--
--   Same policy names, same role (app_user), same command (SELECT); the tables stay append-only by grant (891 §5).
--
-- Rollback: re-run 891 §4 (CREATE POLICY … USING (public.audit_snapshot_reader(company_id))).
-- Locks: DROP / CREATE POLICY take ACCESS EXCLUSIVE on each table for a catalogue-only change.

DROP POLICY IF EXISTS audit_check_runs_read ON public.audit_check_runs;
CREATE POLICY audit_check_runs_read ON public.audit_check_runs FOR SELECT TO app_user
  USING (company_id = (SELECT app.current_company_id()) AND (SELECT public.audit_snapshot_reader(app.current_company_id())));

DROP POLICY IF EXISTS audit_check_results_read ON public.audit_check_results;
CREATE POLICY audit_check_results_read ON public.audit_check_results FOR SELECT TO app_user
  USING (company_id = (SELECT app.current_company_id()) AND (SELECT public.audit_snapshot_reader(app.current_company_id())));

DROP POLICY IF EXISTS audit_snapshots_read ON public.audit_snapshots;
CREATE POLICY audit_snapshots_read ON public.audit_snapshots FOR SELECT TO app_user
  USING (company_id = (SELECT app.current_company_id()) AND (SELECT public.audit_snapshot_reader(app.current_company_id())));

DROP POLICY IF EXISTS audit_snapshot_tb_read ON public.audit_snapshot_tb;
CREATE POLICY audit_snapshot_tb_read ON public.audit_snapshot_tb FOR SELECT TO app_user
  USING (company_id = (SELECT app.current_company_id()) AND (SELECT public.audit_snapshot_reader(app.current_company_id())));

DROP POLICY IF EXISTS audit_snapshot_journals_read ON public.audit_snapshot_journals;
CREATE POLICY audit_snapshot_journals_read ON public.audit_snapshot_journals FOR SELECT TO app_user
  USING (company_id = (SELECT app.current_company_id()) AND (SELECT public.audit_snapshot_reader(app.current_company_id())));

DROP POLICY IF EXISTS audit_snapshot_lines_read ON public.audit_snapshot_lines;
CREATE POLICY audit_snapshot_lines_read ON public.audit_snapshot_lines FOR SELECT TO app_user
  USING (company_id = (SELECT app.current_company_id()) AND (SELECT public.audit_snapshot_reader(app.current_company_id())));

-- Every audit table still has exactly its one read policy, in the once-per-query form.
DO $$
DECLARE
  v_bad pg_catalog.int4;
BEGIN
  SELECT pg_catalog.count(*) INTO v_bad
  FROM (VALUES ('audit_check_runs'), ('audit_check_results'), ('audit_snapshots'), ('audit_snapshot_tb'),
               ('audit_snapshot_journals'), ('audit_snapshot_lines')) t(name)
  WHERE (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = t.name) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = t.name AND p.policyname = t.name || '_read'
                      AND p.cmd = 'SELECT' AND p.roles = ARRAY['app_user']::pg_catalog.name[]
                      AND p.qual NOT LIKE '%audit_snapshot_reader(company_id)%');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'migration 893: % audit table(s) do not carry exactly the once-per-query read policy', v_bad;
  END IF;
END $$;
