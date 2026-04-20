-- Migration 400: Loan payment records
-- Stores each cash payment against a loan with principal/interest split
-- and links back to the GL journal entry created at time of recording.

CREATE TABLE IF NOT EXISTS loan_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  loan_id           uuid NOT NULL REFERENCES loans(id),
  payment_date      date NOT NULL,
  period_number     integer,
  amount            numeric(15,2) NOT NULL,
  principal         numeric(15,2) NOT NULL,
  interest          numeric(15,2) NOT NULL,
  bank_account_id   uuid,
  journal_entry_id  uuid REFERENCES gl_journal_entries(id),
  created_by        uuid,
  created_at        timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_payments_company_loan
  ON loan_payments (company_id, loan_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_payments_period_once
  ON loan_payments (company_id, loan_id, period_number)
  WHERE period_number IS NOT NULL;
