-- WP7: a client query whose WhatsApp send could not be confirmed (a timeout, a connection reset, a 5xx from the
-- provider: the message MAY have gone out) is recorded as 'unconfirmed', never 'sent'. It stays open for reply
-- matching (the client may answer it) and is shown as "send not confirmed". A definite refusal (not configured,
-- a 4xx validation error) deletes the row instead.
SET LOCAL lock_timeout = '5s';

-- Drop the status CHECK by lookup, not by name: the constraint is auto-named in 496 and may differ per environment.
-- Matched on the column (a CHECK over the status column alone), not on the definition text: an unrelated CHECK that
-- merely mentions "status" must survive.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'bank_tx_queries'::regclass
      AND con.contype = 'c'
      AND con.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'bank_tx_queries'::regclass AND a.attname = 'status')]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE bank_tx_queries DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE bank_tx_queries
  ADD CONSTRAINT bank_tx_queries_status_check
  CHECK (status = ANY (ARRAY['sent'::text, 'replied'::text, 'resolved'::text, 'cancelled'::text, 'unconfirmed'::text]));

-- Reply matching now also scans 'unconfirmed' rows: widen the partial index (same name).
DROP INDEX IF EXISTS idx_btq_open_number;
CREATE INDEX IF NOT EXISTS idx_btq_open_number
  ON bank_tx_queries(company_id, to_number)
  WHERE status IN ('sent','replied','unconfirmed');
