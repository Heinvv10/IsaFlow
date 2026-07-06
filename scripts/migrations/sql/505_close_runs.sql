-- 505_close_runs.sql
-- Phase 5 — Close Agent v1 (month-end close automation flagship).
--
-- A close run is a persisted, per-period review-and-approve session. The agent
-- computes the period's readiness checklist (periodCloseReadinessService) and
-- turns it into a list of PROPOSALS. Each proposal is either:
--   - auto_post: the agent can execute it on explicit one-click human approval
--     (post a draft journal through the existing posting service), or
--   - advisory:  the agent can only surface it with evidence — a human clears it
--     in the linked module. Nothing here ever posts autonomously (P5.3 honesty).
--
-- Every executed approval also writes an audit_log row carrying the proposal's
-- reasoning (see closeRunService) — this table is the agent's proposal ledger,
-- audit_log remains the immutable financial audit trail.

CREATE TABLE IF NOT EXISTS close_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fiscal_period_id  UUID NOT NULL REFERENCES fiscal_periods(id) ON DELETE CASCADE,
  period_label      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'completed', 'abandoned')),
  overall_readiness TEXT,                          -- 'pass' | 'warn' | 'fail' snapshot at start
  created_by        UUID NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_close_runs_company_period
  ON close_runs(company_id, fiscal_period_id, created_at DESC);

CREATE TABLE IF NOT EXISTS close_run_proposals (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  close_run_id       UUID NOT NULL REFERENCES close_runs(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL,               -- ProposalKind (post_draft_journal, bank_unreconciled, ...)
  action_type        TEXT NOT NULL
                       CHECK (action_type IN ('auto_post', 'advisory')),
  title              TEXT NOT NULL,
  reasoning          TEXT NOT NULL,               -- the agent's "why", shown to the human before approval
  evidence           JSONB NOT NULL DEFAULT '{}', -- underlying rows/query/count — the honesty rule made concrete
  target_entity_type TEXT,                        -- e.g. 'gl_journal_entry' (auto_post targets)
  target_entity_id   UUID,
  status             TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed', 'approved', 'posted', 'rejected', 'failed', 'dismissed')),
  decided_by         UUID,
  decided_at         TIMESTAMPTZ,
  result             JSONB,                        -- posting result (entry_number) or error detail
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_close_run_proposals_run
  ON close_run_proposals(close_run_id, status);
CREATE INDEX IF NOT EXISTS idx_close_run_proposals_company_status
  ON close_run_proposals(company_id, status);

-- RLS: defence-in-depth on the authenticated app path (SET LOCAL ROLE app_user).
-- The runtime pool role is BYPASSRLS; the explicit `AND company_id = …` filter in
-- every query remains the primary tenant guard. Membership-based predicate mirrors
-- migration 498 so it can never block a legitimate write while staying fail-closed
-- against cross-tenant access. Helpers auth.uid() from migration 348.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['close_runs', 'close_run_proposals'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format($p$
        CREATE POLICY tenant_isolation ON public.%1$I
          FOR ALL TO app_user
          USING (company_id IN (
            SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
          ))
          WITH CHECK (company_id IN (
            SELECT company_id FROM public.company_users WHERE user_id = auth.uid()
          ));
      $p$, t);
    END IF;
  END LOOP;
END $$;
