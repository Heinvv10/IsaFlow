-- 991: What the POP bank-line matcher decided for each proof of payment (POP inbox, phase 2).
--
-- WHAT. The mirror cron (capture/pop/popMatchSweep.ts) looks for each filed proof_of_payments row's
-- debit on the company's own bank lines: same amount, dated payment_date .. payment_date + 3 days, and
-- the beneficiary ABSA printed inside the line's description. One row per POP records the outcome:
--   attached   exactly one line matched and no other open POP claims it: the document was attached to
--              it (captured_documents.matched_bank_tx_id, captureBankTxAttachService). Final.
--   ambiguous  more than one line matched, or the one line also matches another open POP. Nothing was
--              attached; candidate_bank_tx_ids is the suggestion for a person. Final for the matcher.
--   not_found  no single free line yet, or one whose bank account is not imported past the window yet.
--              Checked again on later ticks until payment_date + 45 days, then left.
--   refused    one line matched but the attach refused (refusal = its reason). Final for the matcher.
-- There was no existing suggestion store for captured documents and bank lines, hence this table.
--
-- FINAL MEANS FINAL. Only a 'not_found' row may change (the matcher's upsert says so, and the trigger
-- below refuses any UPDATE of a row whose outcome is already final, for every role).
--
-- Tenancy: 989's forced-RLS policy verbatim. The POP is referenced with its company
-- (proof_of_payment_id, company_id): a foreign key check bypasses RLS, so a single-column reference
-- would let one tenant's session claim another tenant's POP id and so stop it ever being matched.
-- app_user (and app_service through it): SELECT, INSERT of the decision, UPDATE of the decision columns
-- (the not_found re-check). No DELETE. candidate_bank_tx_ids is not a foreign key: read it joined to
-- bank_transactions on the row's company_id.

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_proof_of_payments_id_company ON proof_of_payments (id, company_id);

CREATE TABLE IF NOT EXISTS proof_of_payment_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  proof_of_payment_id UUID NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('attached', 'ambiguous', 'not_found', 'refused')),
  candidate_bank_tx_ids UUID[] NOT NULL DEFAULT '{}',
  refusal TEXT CHECK (length(refusal) <= 64),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT proof_of_payment_matches_one_per_pop UNIQUE (proof_of_payment_id),
  CONSTRAINT proof_of_payment_matches_pop_fkey FOREIGN KEY (proof_of_payment_id, company_id)
    REFERENCES proof_of_payments (id, company_id) ON DELETE CASCADE,
  CONSTRAINT proof_of_payment_matches_shape CHECK (
    (outcome = 'not_found' AND cardinality(candidate_bank_tx_ids) = 0 AND refusal IS NULL)
    OR (outcome = 'attached' AND cardinality(candidate_bank_tx_ids) = 1 AND refusal IS NULL)
    OR (outcome = 'ambiguous' AND cardinality(candidate_bank_tx_ids) >= 1 AND refusal IS NULL)
    OR (outcome = 'refused' AND cardinality(candidate_bank_tx_ids) = 1 AND refusal IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_proof_of_payment_matches_company ON proof_of_payment_matches (company_id, outcome);

ALTER TABLE proof_of_payment_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE proof_of_payment_matches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON proof_of_payment_matches;
CREATE POLICY tenant_isolation ON proof_of_payment_matches FOR ALL TO app_user
  USING (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id() AND company_id IN (SELECT auth.user_companies()));
-- 348's default privileges gave app_user every command: take back all but SELECT, then grant what the matcher writes.
REVOKE INSERT, UPDATE, DELETE ON proof_of_payment_matches FROM app_user;
GRANT SELECT ON proof_of_payment_matches TO app_user;
GRANT INSERT (company_id, proof_of_payment_id, outcome, candidate_bank_tx_ids, refusal)
  ON proof_of_payment_matches TO app_user;
GRANT UPDATE (outcome, candidate_bank_tx_ids, refusal, checked_at) ON proof_of_payment_matches TO app_user;

CREATE OR REPLACE FUNCTION public.proof_of_payment_matches_final() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.outcome <> 'not_found' THEN
    RAISE EXCEPTION 'proof_of_payment_matches: outcome % of POP % is final', OLD.outcome, OLD.proof_of_payment_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.proof_of_payment_matches_final() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_proof_of_payment_matches_final ON proof_of_payment_matches;
CREATE TRIGGER trg_proof_of_payment_matches_final
  BEFORE UPDATE ON proof_of_payment_matches
  FOR EACH ROW EXECUTE FUNCTION public.proof_of_payment_matches_final();

SELECT public.app_service_sync_policies();
