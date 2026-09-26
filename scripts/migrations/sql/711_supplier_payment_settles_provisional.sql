-- 711 (R-127): a bank-first provisional journal can become the payment of ONE
-- supplier invoice.
--
-- When a supplier invoice is approved and its source document already
-- evidences a provisional journal (DR expense / DR VAT, CR bank), the approval
-- reclasses the provisional into the invoice's payment and records a
-- supplier_payments row for it (ap/provisionalInvoiceSettlement.ts). This
-- column names the provisional that payment consumed, and the partial unique
-- index is the claim: while one live payment holds a provisional, no second
-- payment can — so one bank outflow cannot settle two invoices even if the
-- row lock in the application is bypassed. A cancelled (voided) payment
-- releases the claim.
ALTER TABLE supplier_payments
  ADD COLUMN IF NOT EXISTS settles_provisional_je_id UUID REFERENCES gl_journal_entries(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_payments_settles_provisional_je
  ON supplier_payments (settles_provisional_je_id)
  WHERE settles_provisional_je_id IS NOT NULL AND status <> 'cancelled';

-- Same company. gl_journal_entries has no UNIQUE (company_id, id) for a
-- composite FK to reference, and adding one would build a new unique index
-- over the whole journal table for this column alone — so a trigger refuses a
-- payment naming another company's journal, with the FK's own SQLSTATE.
--
-- SECURITY INVOKER on purpose. Its lookup reads gl_journal_entries under the
-- caller's RLS, and that cannot refuse a legitimate row:
--   * every app_user context (withAuth, the MCP bearer pipeline, extension and
--     invite tokens, platform admin) sets request.jwt.claims AND
--     app.current_company_id together; a context with neither runs as the
--     connection role, which RLS does not restrict;
--   * the one writer of the column (ap/provisionalInvoiceSettlement.ts) takes
--     the journal id from a read of gl_journal_entries made in the SAME
--     transaction under the SAME RLS view (provisionalSettlementClaim.ts), so
--     whenever it can name the journal, this lookup can see it.
-- A forged row naming a journal the caller cannot see is refused either way.
-- SECURITY DEFINER would need an owner with BYPASSRLS, which migration_admin
-- does not have on every database this runs on; asserting it would fail the
-- migration there, and making the assertion conditional would make it absent.
CREATE OR REPLACE FUNCTION supplier_payments_settles_provisional_same_company()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.settles_provisional_je_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM gl_journal_entries
    WHERE id = NEW.settles_provisional_je_id AND company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'supplier payment % names provisional journal % of another company',
      NEW.id, NEW.settles_provisional_je_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sp_settles_provisional_same_company ON supplier_payments;
CREATE TRIGGER trg_sp_settles_provisional_same_company
  BEFORE INSERT OR UPDATE OF settles_provisional_je_id, company_id ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION supplier_payments_settles_provisional_same_company();
