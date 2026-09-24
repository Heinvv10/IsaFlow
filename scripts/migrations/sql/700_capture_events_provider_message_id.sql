-- 700: a Twilio retry must not ingest the same WhatsApp message twice (K-160).
--
-- Twilio redelivers a webhook on any non-2xx or timeout. ingestTwilioPayload
-- had no natural key, so every redelivery created another captured_documents
-- row, capture_event and VLM extraction. The key is the provider's message id
-- plus the part within that message: one WhatsApp message carries up to 10
-- media, each its own event (part = media index; the text-command event is
-- part -1). Rows written before this migration keep NULL and are not covered —
-- historical duplicates need a hand-checked cleanup, not a constraint.
--
-- ingestTwilioPayload skips parts already present and inserts with
-- ON CONFLICT DO NOTHING against this index, so two deliveries racing each
-- other yield one event and the loser still answers 200.

ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
ALTER TABLE capture_events ADD COLUMN IF NOT EXISTS provider_message_part SMALLINT;

-- A NULL part would be distinct in the unique index and let duplicates through.
ALTER TABLE capture_events DROP CONSTRAINT IF EXISTS capture_events_provider_message_part_check;
ALTER TABLE capture_events ADD CONSTRAINT capture_events_provider_message_part_check
  CHECK ((provider_message_id IS NULL) = (provider_message_part IS NULL));

-- Not CONCURRENTLY (the runner wraps each file in a transaction); partial on an all-NULL new column, so the build is near-instant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_capture_events_provider_message
  ON capture_events (company_id, provider_message_id, provider_message_part)
  WHERE provider_message_id IS NOT NULL;
