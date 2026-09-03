-- 540: 'contra' as a payment method on both payment tables
--
-- R371,470 of Brightsphere AP was settled in Sage by contra — netted against a
-- loan or intercompany account — with no payment document, and IsaFlow could
-- not express it. The audit read that as "no contra settlement path exists".
-- That is not quite what the code says.
--
-- Both payment services resolve their cash leg as
-- `SELECT * FROM gl_accounts WHERE id = payment.bank_account_id`, with NO
-- subtype check, and the column is a plain FK to gl_accounts(id). So
-- confirmCustomerPayment against a loan account already posts
-- DR Loan / CR Accounts Receivable, and processSupplierPayment already posts
-- DR Accounts Payable / CR Loan. The ledger half has always worked; the column
-- is simply named for a bank and is not one.
--
-- What was genuinely missing is the LABEL. `payment_method` is checked against
-- ('eft','cheque','cash','card'), so a contra settlement is indistinguishable
-- from an EFT that never happened — which is the finding restated: a settlement
-- recorded as a bank payment that did not occur. Widening the check is what
-- lets settle_by_contra record what actually happened, and lets a report
-- separate real cash movement from a netting entry.
--
-- Both constraints are strictly WIDENED, so every existing row already
-- satisfies the new one. They are still added NOT VALID and validated
-- separately: a plain ADD CONSTRAINT ... CHECK takes an ACCESS EXCLUSIVE lock
-- for a full validation scan, which on a payment table blocks every write in
-- flight. NOT VALID takes the lock only briefly; VALIDATE CONSTRAINT scans
-- under a SHARE UPDATE EXCLUSIVE lock that readers and writers do not block on.
--
-- DROP ... IF EXISTS then ADD is the only shape available: Postgres has no
-- ALTER CONSTRAINT for a CHECK expression. The window between them is inside
-- one transaction, so no row can be written against the missing constraint.

ALTER TABLE customer_payments
  DROP CONSTRAINT IF EXISTS customer_payments_payment_method_check;

ALTER TABLE customer_payments
  ADD CONSTRAINT customer_payments_payment_method_check
  CHECK (payment_method IN ('eft', 'cheque', 'cash', 'card', 'contra'))
  NOT VALID;

ALTER TABLE customer_payments
  VALIDATE CONSTRAINT customer_payments_payment_method_check;

ALTER TABLE supplier_payments
  DROP CONSTRAINT IF EXISTS supplier_payments_payment_method_check;

ALTER TABLE supplier_payments
  ADD CONSTRAINT supplier_payments_payment_method_check
  CHECK (payment_method IN ('eft', 'cheque', 'cash', 'card', 'contra'))
  NOT VALID;

ALTER TABLE supplier_payments
  VALIDATE CONSTRAINT supplier_payments_payment_method_check;

-- Finding a contra settlement afterwards has to be cheap, or the label buys
-- nothing: "which receivables were netted rather than banked" is the question
-- a reviewer asks, and a sequential scan over every payment is the answer
-- nobody runs twice. Partial indexes, so they cost nothing on the ordinary
-- rows.
CREATE INDEX IF NOT EXISTS idx_customer_payments_contra
  ON customer_payments (company_id, payment_date)
  WHERE payment_method = 'contra';

CREATE INDEX IF NOT EXISTS idx_supplier_payments_contra
  ON supplier_payments (company_id, payment_date)
  WHERE payment_method = 'contra';
