-- 1040: trial lifecycle emails. One marker row per (company, stage) so the daily trial email run
-- (POST /api/cron/trial-lifecycle-emails, src/modules/onboarding/services/trialLifecycle/) mails each
-- stage at most once per company. Nothing here sends anything.
--
-- WHAT.
--   trial_lifecycle_emails  one row per company and stage.
--     stage    setup_nudge | check_in | ending_soon | ended
--     outcome  pending   claimed in its own committed transaction BEFORE any mail leaves;
--              sent      at least one owner's email went;
--              unknown   no send succeeded but one may have left (a deadline or an ambiguous error);
--              released  every send provably did not leave: the next run may claim the stage again
--                        (the claim's ON CONFLICT ... DO UPDATE re-arms only a released row);
--              skipped_setup_complete  day 3 found nothing left to set up, so no mail was sent.
--     Every outcome but 'released' counts as done for idempotency, and blocks every lower stage.
--   UNIQUE (company_id, stage) is the atomic claim. email_log is not used for this: it has no stage,
--   no unique key, keeps failures too, and its writer swallows its own errors.
--
-- RLS. Tenant-scoped like every company table (954's shape): ENABLE + FORCE, tenant_isolation for
-- app_user. app_user holds SELECT and only the column INSERT/UPDATE the cron uses, and no DELETE,
-- so app_service_sync_policies() (915) gives the cron's service role exactly those mirrors. A tenant
-- session can at most touch its own company's markers (suppress or re-arm its own trial emails).
--
-- OLD COLOUR. The release before this one never reads or writes the table.
--
-- LOCKS. A new table and its policies only; bounded by lock_timeout.
--
-- Rollback (down SQL; roll the code back first, to a release that never reads this table):
--   DROP TABLE IF EXISTS public.trial_lifecycle_emails;
--   SELECT public.app_service_sync_policies();

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.trial_lifecycle_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('setup_nudge', 'check_in', 'ending_soon', 'ended')),
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'sent', 'unknown', 'released', 'skipped_setup_complete')),
  recipient_count INTEGER NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT trial_lifecycle_emails_company_stage_key UNIQUE (company_id, stage)
);

COMMENT ON TABLE public.trial_lifecycle_emails IS
  '1040: one row per company and trial email stage; the claim that keeps each stage to one send.';

ALTER TABLE public.trial_lifecycle_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trial_lifecycle_emails FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.trial_lifecycle_emails;
CREATE POLICY tenant_isolation ON public.trial_lifecycle_emails FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
REVOKE ALL ON public.trial_lifecycle_emails FROM app_user;
GRANT SELECT ON public.trial_lifecycle_emails TO app_user;
GRANT INSERT (company_id, stage, outcome, recipient_count, sent_at) ON public.trial_lifecycle_emails TO app_user;
GRANT UPDATE (outcome, recipient_count, sent_at, created_at) ON public.trial_lifecycle_emails TO app_user;

SELECT public.app_service_sync_policies();
