-- PRD-06 Phase 5 — Dunning Engine (templates + sends + settings)
-- See docs/prd/PRD-06-ar-evidence-capture.md §4.6 and §7.2 Phase 5.
--
-- Adds a template-driven dunning stack that coexists with the older
-- dunning_communications table (mig 253, customer-level, no template FK).
-- The old table is intentionally left untouched.

-- Per-template ladder entry. Four SA-default tones: polite / firm / final / legal.
CREATE TABLE IF NOT EXISTS dunning_templates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  days_overdue_min     int  NOT NULL,
  days_overdue_max     int,                            -- null = open-ended (final / legal tail)
  subject_template     text NOT NULL,
  body_template        text NOT NULL,
  tone                 text NOT NULL DEFAULT 'polite'
                         CHECK (tone IN ('polite','firm','final','legal')),
  escalation_order     int  NOT NULL DEFAULT 1,
  send_weekdays_only   boolean NOT NULL DEFAULT true,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  CHECK (days_overdue_max IS NULL OR days_overdue_max >= days_overdue_min)
);

CREATE INDEX IF NOT EXISTS idx_dunning_templates_ladder
  ON dunning_templates (company_id, escalation_order)
  WHERE active = true;

-- Each send is an immutable audit row. Subject / body are snapshotted at
-- send-time so future template edits don't rewrite history.
CREATE TABLE IF NOT EXISTS dunning_sends (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_invoice_id   uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  template_id           uuid NOT NULL REFERENCES dunning_templates(id),
  sent_at               timestamptz NOT NULL DEFAULT now(),
  sent_to_email         text NOT NULL,
  rendered_subject      text NOT NULL,
  rendered_body         text NOT NULL,
  trigger_source        text NOT NULL DEFAULT 'manual'
                          CHECK (trigger_source IN ('manual','cron','auto')),
  sent_by               varchar(255) REFERENCES users(id),   -- null for cron; users.id is VARCHAR(255)
  message_token         uuid NOT NULL DEFAULT gen_random_uuid(),  -- webhook correlator
  source_document_id    uuid REFERENCES captured_documents(id) ON DELETE SET NULL,
  response_received_at  timestamptz,
  response_action       text
                          CHECK (response_action IN ('paid','promised','disputed','silent')),
  response_note         text,
  email_status          text NOT NULL DEFAULT 'sent'
                          CHECK (email_status IN ('sent','failed','pending')),
  email_error           text,
  UNIQUE (message_token)
);

CREATE INDEX IF NOT EXISTS idx_dunning_sends_company_recent
  ON dunning_sends (company_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_dunning_sends_invoice
  ON dunning_sends (customer_invoice_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_dunning_sends_awaiting_response
  ON dunning_sends (company_id, sent_at DESC)
  WHERE response_action IS NULL;

-- Per-company opt-in for cron auto-send. Default is preview-only so no
-- customer inbox is touched until an admin flips the switch.
CREATE TABLE IF NOT EXISTS dunning_settings (
  company_id            uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  auto_send_enabled     boolean NOT NULL DEFAULT false,
  min_outstanding_zar   numeric(15,2) NOT NULL DEFAULT 0,   -- skip tiny balances
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
