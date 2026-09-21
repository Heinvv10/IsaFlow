-- 678: row-level security for credit_note_allocations.
--
-- The table is created by 677, which is already applied — and an applied
-- migration is never edited, because the runner refuses on a checksum mismatch
-- and every environment that has it would then be stuck. So the protection
-- lands here instead.
--
-- WHY IT MATTERS ON THIS TABLE SPECIFICALLY. Each row says that a named credit
-- note took a named amount off a named document. A row readable across tenants
-- discloses another company's credit position; a row WRITABLE across tenants is
-- worse, because `cancelCreditNote` reads these rows and hands the money back —
-- a forged row is an instruction to reduce a stranger's `amount_paid`. The
-- invoice_id is deliberately not a foreign key (it points at customer_invoices
-- or supplier_invoices depending on the note's type), so nothing else in the
-- schema constrains which document a row may name. This policy is what does.
--
-- The shape is the one every other tenant table uses — see 645 for the same
-- four statements — and is deliberately not paraphrased:
--
--   ENABLE   turns the policy on for ordinary roles.
--   FORCE    applies it to the table's OWNER too. Without it the owner reads
--            and writes every tenant's rows, and the owner is not always the
--            role a reader assumes.
--   USING    what a row must satisfy to be VISIBLE.
--   WITH CHECK  what a row must satisfy to be WRITTEN — and it is the stricter
--            of the two on purpose: you may read any company you belong to, and
--            write only the one the request is currently acting as.
--
-- DROP + CREATE rather than a guard: Postgres has no CREATE POLICY IF NOT
-- EXISTS, and the pair is idempotent, so this file re-runs cleanly.

ALTER TABLE credit_note_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_allocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON credit_note_allocations;
CREATE POLICY tenant_isolation ON credit_note_allocations
  FOR ALL
  TO app_user
  USING (company_id IN (SELECT auth.user_companies()))
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON credit_note_allocations TO app_user;
