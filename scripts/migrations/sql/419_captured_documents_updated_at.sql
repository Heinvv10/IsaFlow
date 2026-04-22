-- 419_captured_documents_updated_at.sql
-- Add updated_at column to captured_documents.
-- captureRouterService + whatsAppInboundService + inboundEmailService all
-- write `SET updated_at = NOW()`; column was missing, so extraction errors
-- aborted before the event could reach the inbox UI.

ALTER TABLE captured_documents
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Keep it fresh on every row update
CREATE OR REPLACE FUNCTION captured_documents_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_captured_documents_touch ON captured_documents;
CREATE TRIGGER trg_captured_documents_touch
  BEFORE UPDATE ON captured_documents
  FOR EACH ROW EXECUTE FUNCTION captured_documents_touch_updated_at();
