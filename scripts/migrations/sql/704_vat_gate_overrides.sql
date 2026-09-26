-- 704: VAT gate overrides.
--
-- getVatExceptions' BLOCKING exceptions (totalExceptions) already refuse SARS
-- ISV filing (sarsEfilingSubmissionService.evaluateEfilingGate, no override).
-- This extends the same blocking count to two more actions that commit a VAT
-- period as filed without going through ISV: locking a VAT period
-- (vat-period-locks.ts / lock_vat_period) and manually marking a VAT201
-- submission as submitted (sars-submissions.ts). Both may now proceed with
-- blocking exceptions present ONLY when an owner/admin supplies a non-empty
-- reason — recorded here, never deleted, same shape as 695's unlock history:
-- actor, reason, and a snapshot of what was overridden.
--
-- ISV itself keeps blocking with NO override (Hein, 2026-09-26) — this table
-- is never consulted by evaluateEfilingGate.

CREATE TABLE IF NOT EXISTS vat_gate_overrides (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id),
  target_type         TEXT NOT NULL CHECK (target_type IN ('vat_period_lock', 'sars_submission')),
  -- A NEW lock's row does not exist yet when its gate is checked (the override
  -- is recorded before lockVatPeriod's own INSERT) so this is nullable; a
  -- sars_submission override always has one — the draft submission already exists.
  target_id           UUID,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  -- users.id is character varying(255), not uuid — same reason vat_period_locks.locked_by is TEXT.
  actor               TEXT NOT NULL,
  reason              TEXT NOT NULL,
  -- Counts by exception type at the moment of the override, so a later reader
  -- can see what was overridden without re-deriving it from a report that may
  -- since have changed.
  exception_snapshot  JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vat_gate_overrides_range_ck CHECK (period_end >= period_start),
  CONSTRAINT vat_gate_overrides_actor_ck CHECK (btrim(actor) <> ''),
  CONSTRAINT vat_gate_overrides_reason_ck CHECK (btrim(reason) <> '')
);

CREATE INDEX IF NOT EXISTS idx_vat_gate_overrides_company_period
  ON vat_gate_overrides (company_id, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_vat_gate_overrides_target
  ON vat_gate_overrides (company_id, target_type, target_id);

ALTER TABLE vat_gate_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE vat_gate_overrides FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'vat_gate_overrides' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON vat_gate_overrides
      TO app_user
      USING (company_id IN (SELECT auth.user_companies()))
      WITH CHECK (company_id = app.current_company_id());
  END IF;
END $$;
