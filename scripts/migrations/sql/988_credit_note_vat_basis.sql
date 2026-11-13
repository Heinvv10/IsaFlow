-- 988: credit_notes.vat_basis — how a credit note's VAT was set (brief step 5b, 13 Nov 2026).
--
-- WHY. MCP create_credit_note with mirror_bill sets a supplier note's VAT from its bill AS IT STANDS
-- when the draft is created (ap/supplierCreditNoteMirror). Between that create and the approval, a
-- later credit note or a hand-made journal can reverse some of the bill's VAT; approving the draft
-- then reverses that VAT a second time (SIV3762: JE-2026-26788, then CN-557). approveCreditNote must
-- re-check such a note against the bill, and ONLY such a note: a note raised at its own rate (REST,
-- imports, MCP without mirror_bill) keeps today's behaviour (Hein, 2026-11-13, option A). Nothing on
-- the row could tell the two apart: external_system is the source-system identity (migration 530).
--
-- WHAT. vat_basis TEXT NOT NULL DEFAULT 'rate', CHECK in ('rate', 'mirror_bill').
--   'rate'        tax_amount = subtotal x tax_rate, or as the caller gave it — every existing row and
--                 every path except the one below;
--   'mirror_bill' set only by createCreditNote when the MCP tool passes mirror_bill.
-- Fixed at create: no path updates it, so the approval digest (R-035) needs no new element, as 892
-- reasoned for gl_account_id. Table-level grants on credit_notes already cover the column.
--
-- LOCKS. A constant default is catalogue-only on PG 11+ (no rewrite); ADD COLUMN still takes ACCESS
-- EXCLUSIVE briefly, bounded below. The CHECK is added NOT VALID (no scan under that lock) and then
-- VALIDATEd, which scans under SHARE UPDATE EXCLUSIVE only (every existing row is 'rate').
--
-- Rollback (down SQL), safe at any time; code before this migration never reads the column, and code
-- after it treats a missing value as 'rate' on read but INSERTs it, so roll the code back first:
--   ALTER TABLE public.credit_notes DROP CONSTRAINT IF EXISTS credit_notes_vat_basis_check;
--   ALTER TABLE public.credit_notes DROP COLUMN IF EXISTS vat_basis;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS vat_basis TEXT NOT NULL DEFAULT 'rate';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_notes_vat_basis_check' AND conrelid = 'public.credit_notes'::regclass
  ) THEN
    ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_vat_basis_check
      CHECK (vat_basis IN ('rate', 'mirror_bill')) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.credit_notes VALIDATE CONSTRAINT credit_notes_vat_basis_check;

COMMENT ON COLUMN public.credit_notes.vat_basis IS
  'How tax_amount was set: rate (subtotal x tax_rate, or as given) or mirror_bill (MCP create_credit_note mirror_bill: the bill''s VAT as it stood). approveCreditNote re-checks mirror_bill notes against the bill''s standing VAT.';
