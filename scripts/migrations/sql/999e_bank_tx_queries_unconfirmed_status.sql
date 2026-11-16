-- WP7: a client query whose WhatsApp send could not be confirmed (a timeout, a connection reset, a 5xx from the
-- provider: the message MAY have gone out) is recorded as 'unconfirmed', never 'sent'. It stays open for reply
-- matching (the client may answer it) and is shown as "send not confirmed". A definite refusal (not configured,
-- a 4xx validation error) deletes the row instead.
SET LOCAL lock_timeout = '5s';

ALTER TABLE bank_tx_queries DROP CONSTRAINT IF EXISTS bank_tx_queries_status_check;
ALTER TABLE bank_tx_queries
  ADD CONSTRAINT bank_tx_queries_status_check
  CHECK (status = ANY (ARRAY['sent'::text, 'replied'::text, 'resolved'::text, 'cancelled'::text, 'unconfirmed'::text])) NOT VALID;
ALTER TABLE bank_tx_queries VALIDATE CONSTRAINT bank_tx_queries_status_check;
