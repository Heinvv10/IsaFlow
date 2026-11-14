-- 989: Proof-of-payment notices read from a mirrored mailbox (POP inbox, phase 1).
--
-- WHAT.
--   proof_of_payments  one bank-issued notice of an outgoing payment, read from its PDF:
--     the bank's transaction number, the payment date, amount, beneficiary and reference.
--     The PDF itself is the captured_documents row it names (document_type
--     'proof_of_payment'). Phase 1 writes only 'absa_notice' rows: ABSA "Notice of
--     payment" mail whose DKIM signature verified (capture/pop/absaPopTrust.ts).
--
-- ONE ROW PER BANK TRANSACTION. UNIQUE (company_id, source, transaction_number): the same
-- notice re-sent, forwarded or re-scanned files nothing twice; the ingest inserts
-- ON CONFLICT DO NOTHING inside the transaction that creates the document, so a losing
-- concurrent scan rolls its document back too.
--
-- WHO WRITES. The IMAP mirror cron (app_service, a member of app_user). An app session
-- can read its company's rows and insert into its own company only (RLS); no UPDATE or
-- DELETE privilege: a notice is a bank's record and is never edited. Removal is the
-- company's deletion (CASCADE) or a migration_admin fix.
--
-- Tenancy: 944's forced-RLS policy verbatim. No SECURITY DEFINER code here.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS proof_of_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  captured_document_id UUID NOT NULL REFERENCES captured_documents(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('absa_notice')),
  transaction_number TEXT NOT NULL CHECK (btrim(transaction_number) <> '' AND length(transaction_number) <= 64),
  payment_date DATE NOT NULL,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  beneficiary TEXT NOT NULL CHECK (btrim(beneficiary) <> '' AND length(beneficiary) <= 200),
  beneficiary_bank TEXT CHECK (length(beneficiary_bank) <= 200),
  reference TEXT CHECK (length(reference) <= 200),
  payer_account_name TEXT CHECK (length(payer_account_name) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proof_of_payments_one_per_bank_txn UNIQUE (company_id, source, transaction_number)
);
CREATE INDEX IF NOT EXISTS idx_proof_of_payments_company_date
  ON proof_of_payments (company_id, payment_date);
CREATE INDEX IF NOT EXISTS idx_proof_of_payments_document
  ON proof_of_payments (captured_document_id);

ALTER TABLE proof_of_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_of_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON proof_of_payments;
CREATE POLICY tenant_isolation ON proof_of_payments FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
-- 348's default privileges gave app_user every command: take back all but SELECT, then grant
-- INSERT on the data columns (id and created_at take their defaults).
REVOKE INSERT, UPDATE, DELETE ON proof_of_payments FROM app_user;
GRANT SELECT ON proof_of_payments TO app_user;
GRANT INSERT (company_id, captured_document_id, source, transaction_number, payment_date, amount,
  beneficiary, beneficiary_bank, reference, payer_account_name) ON proof_of_payments TO app_user;

SELECT public.app_service_sync_policies();
