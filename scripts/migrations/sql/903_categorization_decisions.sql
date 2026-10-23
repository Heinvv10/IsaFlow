-- 903: categorization_decisions — the learning loop's decision log (PR 1 of the learning loop; Hein's design
-- answers 2026-10-21). One row per coding suggestion ISAFlow made on a bank line, and what became of it.
--
--   Why a log. bank_transactions keeps only the LATEST suggestion in suggested_*, and those columns are not
--   ISAFlow's alone: save_selection (bank-transactions-action) writes the user's own pick into them, the rule
--   auto-post clears them on post (bankRuleAutoPostLine), and nothing records who accepted what, or when. So
--   "how often is the suggestion accepted" cannot be read from the bank line. This table records it from the
--   day it ships; it has no backfill and readers say "not enough data yet" below a minimum count.
--
--   Lifecycle (codingDecisionLog.ts is the only writer):
--     pending   a suggestion was written to the line (rule / pattern / historical / llm / supplier_rule).
--               At most ONE pending row per line (partial unique index below); a newer suggestion for a
--               line still pending replaces the pending row's suggestion in place.
--     accepted  a person allocated or matched the line to the suggested target, or ISAFlow auto-posted the
--               suggested target (was_auto_posted = true, decided_by NULL).
--     recoded   a person allocated or matched the line to a different target, or marked an auto-posted line
--               as corrected by hand (autoPostHandCorrection.markCorrectedByHand). decided_by NULL on a
--               recoded row means ISAFlow itself posted a different target (a rule auto-post or the import
--               predictor over an open suggestion); readers of "a person's decisions" filter decided_by.
--     rejected  a person excluded a line that still carried a pending suggestion.
--     undone    an auto-posted line was undone (autoPostUndoService) or reversed / unmatched by a person.
--   Only pending -> decided and auto-posted accepted -> recoded / undone are written; a decided row is never
--   re-opened. shared_pool is reserved for PR 2 (pooled suggestions); none is for a decision with no
--   suggestion behind it.
--
--   posted_journal_entry_id is the journal an auto-post put on the books (set exactly when was_auto_posted).
--   An undo / reverse / unmatch / hand correction closes an auto-posted row only while that journal is still
--   the line's posting as it stood before the write, so a person undoing their OWN later allocation never
--   lands on an older auto-post's row. Plain UUID, no FK: gl_journal_entries has no (id, company_id) key,
--   a posted journal is never deleted, and nothing posts from the column.
--
--   Targets. suggested_gl_account_id / final_gl_account_id carry composite (id, company_id) FKs to
--   gl_accounts (489's pattern), so a row can never name another tenant's account. suggested_contact_id /
--   final_contact_id hold the supplier or customer a rule suggested or a person chose: two possible parent
--   tables, so no FK; nothing posts from them, they are read only to decide accepted vs recoded.
--   bank_transaction_id is a composite FK to bank_transactions (id, company_id) ON DELETE CASCADE: deleting
--   a line (import undo) takes its decisions with it. ON DELETE SET NULL (col) is PG15+ (prod is 15.8; 853
--   and 854 use the same form) and nulls only the account column, never company_id.
--
--   decided_by is the users.id (character varying) of the person, never a name; NULL when ISAFlow decided.
--
-- RLS: the standard tenant form (897): a row is visible and writable only for the ACTIVE company AND a
-- company the caller belongs to. Writers: the bank services themselves (allocate, split, match, exclude,
-- unmatch, reverse, the auto-post paths), reached from withAuth routes and the MCP tools, run as app_user
-- with app.current_company_id = the request's company, and every write names that company. The LLM residual pass and
-- cron / feed ingestion run on the BYPASSRLS pool role and are unaffected; their writes still name the
-- company explicitly.
--
-- Grants (876/877's recipe): every non-owner role loses everything, then app_user gets SELECT and INSERT
-- back, and UPDATE only on the decision columns (never id, company_id, bank_transaction_id or created_at).
-- No DELETE or TRUNCATE for any app role: a decision leaves only with its bank line or company.
--
-- Rollback (nothing else references the table):
--   DROP TABLE IF EXISTS public.categorization_decisions;
-- Locks: CREATE TABLE plus FK validation on an empty table; brief SHARE ROW EXCLUSIVE on bank_transactions
-- and gl_accounts for the FK triggers.

CREATE TABLE IF NOT EXISTS categorization_decisions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id     UUID NOT NULL,
  suggestion_source       TEXT NOT NULL CHECK (suggestion_source IN (
    'rule', 'pattern', 'historical', 'llm', 'supplier_rule', 'shared_pool', 'none')),
  suggested_gl_account_id UUID,
  suggested_contact_id    UUID,
  suggested_category      TEXT,
  confidence              NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  was_auto_posted         BOOLEAN NOT NULL DEFAULT false,
  auto_posted_at          TIMESTAMPTZ,
  posted_journal_entry_id UUID,
  outcome                 TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN (
    'pending', 'accepted', 'recoded', 'rejected', 'undone')),
  final_gl_account_id     UUID,
  final_contact_id        UUID,
  -- users.id is character varying(255), not uuid. NULL = ISAFlow decided (auto-post).
  decided_by              TEXT,
  suggested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT categorization_decisions_bank_tx_fk FOREIGN KEY (bank_transaction_id, company_id)
    REFERENCES bank_transactions (id, company_id) ON DELETE CASCADE,
  CONSTRAINT categorization_decisions_suggested_gl_fk FOREIGN KEY (suggested_gl_account_id, company_id)
    REFERENCES gl_accounts (id, company_id) ON DELETE SET NULL (suggested_gl_account_id),
  CONSTRAINT categorization_decisions_final_gl_fk FOREIGN KEY (final_gl_account_id, company_id)
    REFERENCES gl_accounts (id, company_id) ON DELETE SET NULL (final_gl_account_id),
  -- Decided exactly when not pending.
  CONSTRAINT categorization_decisions_decided_ck CHECK ((outcome = 'pending') = (decided_at IS NULL)),
  -- auto_posted_at is the auto-post's own time (decided_at moves on a later undo).
  CONSTRAINT categorization_decisions_auto_ck CHECK (was_auto_posted = (auto_posted_at IS NOT NULL)),
  -- Every auto-post names its journal, so an undo can tell whether it is still the line's posting.
  CONSTRAINT categorization_decisions_auto_journal_ck CHECK (was_auto_posted = (posted_journal_entry_id IS NOT NULL)),
  -- An auto-post is a decision: it is never pending, and nobody "rejected" a line ISAFlow posted.
  CONSTRAINT categorization_decisions_auto_outcome_ck CHECK (NOT (was_auto_posted AND outcome IN ('pending', 'rejected')))
);

-- One open suggestion per line: the writer's ON CONFLICT arbiter.
CREATE UNIQUE INDEX IF NOT EXISTS categorization_decisions_one_pending_uq
  ON categorization_decisions (company_id, bank_transaction_id) WHERE outcome = 'pending';
-- The line's decisions in order (latest auto-posted for undo; first decision for the first-30-days rate).
CREATE INDEX IF NOT EXISTS categorization_decisions_tx_idx
  ON categorization_decisions (company_id, bank_transaction_id, created_at, id);
-- Suggestion-accepted rate over a period.
CREATE INDEX IF NOT EXISTS categorization_decisions_decided_idx
  ON categorization_decisions (company_id, decided_at) WHERE outcome <> 'pending';
-- Re-code rate on auto-posted lines over a period.
CREATE INDEX IF NOT EXISTS categorization_decisions_auto_posted_idx
  ON categorization_decisions (company_id, auto_posted_at) WHERE was_auto_posted;

ALTER TABLE public.categorization_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorization_decisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON public.categorization_decisions;
CREATE POLICY tenant_isolation ON public.categorization_decisions
  FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'categorization_decisions'
      AND grantee <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                      WHERE c.oid = 'public.categorization_decisions'::pg_catalog.regclass)
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON public.categorization_decisions FROM %I', r.grantee);
  END LOOP;
  REVOKE ALL ON public.categorization_decisions FROM PUBLIC;
END $$;
GRANT SELECT, INSERT ON public.categorization_decisions TO app_user;
GRANT UPDATE (suggestion_source, suggested_gl_account_id, suggested_contact_id, suggested_category, confidence,
              was_auto_posted, auto_posted_at, posted_journal_entry_id, outcome, final_gl_account_id, final_contact_id, decided_by,
              suggested_at, decided_at)
  ON public.categorization_decisions TO app_user;

-- Exactly one policy, in this form, and no DELETE / TRUNCATE for app_user.
DO $$
DECLARE
  v_ok pg_catalog.bool;
BEGIN
  SELECT c.relrowsecurity AND c.relforcerowsecurity
     AND (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies p
           WHERE p.schemaname = 'public' AND p.tablename = 'categorization_decisions') = 1
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = 'categorization_decisions'
                    AND p.policyname = 'tenant_isolation' AND p.cmd = 'ALL'
                    AND p.roles = ARRAY['app_user']::pg_catalog.name[]
                    AND p.qual LIKE '%app.current_company_id()%' AND p.qual LIKE '%auth.user_companies()%'
                    AND p.with_check LIKE '%app.current_company_id()%' AND p.with_check LIKE '%auth.user_companies()%')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.categorization_decisions', 'DELETE')
     AND NOT pg_catalog.has_table_privilege('app_user', 'public.categorization_decisions', 'TRUNCATE')
    INTO v_ok
    FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.categorization_decisions'::pg_catalog.regclass;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'migration 903: categorization_decisions is not under FORCE RLS with exactly the active-company policy and append/update-only grants';
  END IF;
END $$;

COMMENT ON TABLE categorization_decisions IS
  'Learning loop decision log: one row per ISAFlow coding suggestion on a bank line and its outcome (pending / accepted / recoded / rejected / undone). Written only by codingDecisionLog.ts.';
