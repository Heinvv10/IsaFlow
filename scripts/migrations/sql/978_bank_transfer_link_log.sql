-- 978: bank_transfer_link_log (app audit 11 Nov 2026, P2.2 / P2.5 item 4).
--
-- WHAT. One row per automatic transfer link: which statement line was tied to
-- which existing journal line, what the line's fields were before, what
-- triggered it (opening Bank Transactions, or a statement import), and, once,
-- when it was undone. An undo restores the prev_* fields exactly, and only
-- while bank_transactions.updated_at still equals linked_row_updated_at.
--
-- WRITES. app_user may SELECT, INSERT named columns, and UPDATE undone_at only.
-- id, linked_at, linked_by and undone_by take their defaults or the trigger's
-- value (a writable stamp gets forged). No DELETE for any app role; the
-- cascade from a deleted statement line or company removes the rows.
--
-- A BEFORE INSERT OR UPDATE trigger (SECURITY INVOKER) refuses a journal line
-- that is not this company's line of the named journal (a plain FK would accept
-- another tenant's id), stamps the actor and time from the session, and lets an
-- UPDATE do nothing but set the undo stamp, once.
--
-- Rollback (down SQL), safe at any time, loses only the log:
--   DROP TABLE IF EXISTS bank_transfer_link_log;
--   DROP FUNCTION IF EXISTS public.bank_transfer_link_log_guard();
--   DROP FUNCTION IF EXISTS public.bank_transfer_link_log_no_truncate();
-- Code that predates this migration never reads or writes the table.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS bank_transfer_link_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  link_batch_id UUID NOT NULL,
  bank_transaction_id UUID NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES gl_accounts(id),
  journal_entry_id UUID NOT NULL,
  journal_line_id UUID NOT NULL,
  counterparty_account_id UUID,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('page_load', 'import')),
  import_batch_id UUID,
  -- The line's fields before the link, restored exactly by an undo.
  prev_status VARCHAR(20) NOT NULL,
  prev_allocation_type TEXT,
  prev_transfer_journal_entry_id UUID,
  prev_matched_journal_line_id UUID,
  prev_counterparty_account_id UUID,
  prev_allocated_entity_name TEXT,
  prev_allocation_rule_id UUID,
  prev_allocation_rule_name TEXT,
  -- bank_transactions.updated_at as the link left it: an undo requires it unchanged.
  linked_row_updated_at TIMESTAMPTZ NOT NULL,
  -- users.id is character varying: actor columns are TEXT, never UUID.
  linked_by TEXT,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_by TEXT,
  undone_at TIMESTAMPTZ,
  CONSTRAINT bank_transfer_link_log_line_fk FOREIGN KEY (bank_transaction_id, company_id)
    REFERENCES bank_transactions (id, company_id) ON DELETE CASCADE,
  CONSTRAINT bank_transfer_link_log_import_ck CHECK (trigger_source = 'import' OR import_batch_id IS NULL)
);

-- One live link per statement line.
CREATE UNIQUE INDEX IF NOT EXISTS uq_btll_active_line
  ON bank_transfer_link_log (bank_transaction_id) WHERE undone_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_btll_company_account_linked
  ON bank_transfer_link_log (company_id, bank_account_id, linked_at DESC);
CREATE INDEX IF NOT EXISTS idx_btll_company_batch
  ON bank_transfer_link_log (company_id, link_batch_id);
-- The passes' "was this pair undone" anti-join.
CREATE INDEX IF NOT EXISTS idx_btll_undone_pair
  ON bank_transfer_link_log (company_id, bank_transaction_id, journal_line_id) WHERE undone_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.bank_transfer_link_log_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.gl_journal_lines jl
                    WHERE jl.id = NEW.journal_line_id AND jl.company_id = NEW.company_id
                      AND jl.journal_entry_id = NEW.journal_entry_id) THEN
      RAISE EXCEPTION 'journal line % is not a line of this company''s journal %', NEW.journal_line_id, NEW.journal_entry_id
        USING ERRCODE = '23514';
    END IF;
    NEW.linked_at := now();
    NEW.linked_by := COALESCE(auth.uid()::text, NEW.linked_by);
    NEW.undone_at := NULL;
    NEW.undone_by := NULL;
    RETURN NEW;
  END IF;
  -- UPDATE: the undo stamp, once, and nothing else.
  IF OLD.undone_at IS NOT NULL THEN
    RAISE EXCEPTION 'this transfer link was already undone' USING ERRCODE = '23514';
  END IF;
  IF NEW.undone_at IS NULL
     OR (to_jsonb(NEW) - 'undone_at' - 'undone_by') IS DISTINCT FROM (to_jsonb(OLD) - 'undone_at' - 'undone_by') THEN
    RAISE EXCEPTION 'a transfer link record only ever gains its undo stamp' USING ERRCODE = '23514';
  END IF;
  NEW.undone_at := now();
  NEW.undone_by := COALESCE(auth.uid()::text, NEW.undone_by);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_bank_transfer_link_log_guard ON bank_transfer_link_log;
CREATE TRIGGER trg_bank_transfer_link_log_guard BEFORE INSERT OR UPDATE ON bank_transfer_link_log
  FOR EACH ROW EXECUTE FUNCTION public.bank_transfer_link_log_guard();
ALTER TABLE bank_transfer_link_log ENABLE ALWAYS TRIGGER trg_bank_transfer_link_log_guard;

CREATE OR REPLACE FUNCTION public.bank_transfer_link_log_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'bank_transfer_link_log rows are history and are never truncated' USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS trg_bank_transfer_link_log_no_truncate ON bank_transfer_link_log;
CREATE TRIGGER trg_bank_transfer_link_log_no_truncate BEFORE TRUNCATE ON bank_transfer_link_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.bank_transfer_link_log_no_truncate();
ALTER TABLE bank_transfer_link_log ENABLE ALWAYS TRIGGER trg_bank_transfer_link_log_no_truncate;

ALTER TABLE bank_transfer_link_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transfer_link_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_transfer_link_log;
CREATE POLICY tenant_isolation ON bank_transfer_link_log FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

-- Default privileges (352, 348) leave platform_admin and others writers: clear them, then give back only what
-- each needs (969 does the same). A table-level REVOKE also clears column grants.
REVOKE ALL ON bank_transfer_link_log FROM app_user, app_service, platform_admin, PUBLIC;
-- Whoever else holds a writer privilege, seen or not (production's ACL is not read here), loses it.
DO $$
DECLARE
  v_grantee pg_catalog.text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
    WHERE c.oid = 'public.bank_transfer_link_log'::pg_catalog.regclass
      AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE') AND a.grantee <> c.relowner
      AND a.grantee IS DISTINCT FROM pg_catalog.to_regrole('migration_admin')::pg_catalog.oid
  LOOP
    EXECUTE pg_catalog.format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.bank_transfer_link_log FROM %s CASCADE', v_grantee);
  END LOOP;
END $$;
GRANT SELECT ON bank_transfer_link_log TO app_user, platform_admin;
GRANT INSERT (company_id, link_batch_id, bank_transaction_id, bank_account_id, journal_entry_id, journal_line_id,
  counterparty_account_id, trigger_source, import_batch_id, prev_status, prev_allocation_type,
  prev_transfer_journal_entry_id, prev_matched_journal_line_id, prev_counterparty_account_id,
  prev_allocated_entity_name, prev_allocation_rule_id, prev_allocation_rule_name, linked_row_updated_at)
  ON bank_transfer_link_log TO app_user;
GRANT UPDATE (undone_at) ON bank_transfer_link_log TO app_user;
REVOKE ALL ON FUNCTION public.bank_transfer_link_log_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bank_transfer_link_log_no_truncate() FROM PUBLIC;
