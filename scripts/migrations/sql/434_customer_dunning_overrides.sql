-- PRD-06 Phase 5 follow-up — per-customer dunning overrides.
--
-- Keyed by (company_id, customer_id). Two knobs per customer:
--   - suppress_dunning: cron walker skips this customer entirely.
--   - template_id_override: when set, cron walker uses this template regardless
--     of the invoice's days_overdue (handy for VIP customers who should always
--     receive the polite tone, or the opposite — customers who skip straight
--     to 'legal' after the first missed due date).
--
-- Dedicated table (rather than columns on customers) keeps the hot AR table
-- lean and gives audit + future expansion room.

CREATE TABLE IF NOT EXISTS customer_dunning_overrides (
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id           uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  suppress_dunning      boolean NOT NULL DEFAULT false,
  template_id_override  uuid REFERENCES dunning_templates(id) ON DELETE SET NULL,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_dunning_overrides_suppressed
  ON customer_dunning_overrides (company_id)
  WHERE suppress_dunning = true;
