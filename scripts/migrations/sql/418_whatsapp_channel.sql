-- PRD-05 Phase 8: WhatsApp inbound + conversational ledger.
--
-- capture_inboxes already accepts channel='whatsapp' (from migration 409). The
-- WABA number gets stored as the inbox's address.
--
-- For chase-via-WhatsApp (Phase 6 extension), suppliers need a WhatsApp
-- number. Also track whether the company has opted into WhatsApp for
-- capture + chase — mirrors the opt-in pattern we used for email chase in
-- migration 416.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;

-- Normalised E.164 format preferred (+27821234567) but we accept any string
-- since we don't enforce at DB layer. Service layer validates before use.

-- Inbound messages carry the Twilio message SID in capture_events.sender/
-- subject; no dedicated column needed beyond the existing raw_payload_url
-- pattern from migration 409.

-- Per-company opt-in for outbound WhatsApp chase. Off by default — chase_auto_
-- send_enabled from migration 416 governs email; this governs WA.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS whatsapp_chase_enabled BOOLEAN NOT NULL DEFAULT FALSE;
