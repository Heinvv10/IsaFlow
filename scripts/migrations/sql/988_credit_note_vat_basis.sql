-- 988: credit_notes.vat_basis + vat_ack_matches — how a credit note's VAT was set (brief step 5b, 13 Nov 2026).
--
-- WHY. MCP create_credit_note with mirror_bill sets a supplier note's VAT from its bill AS IT STANDS
-- when the draft is created (ap/supplierCreditNoteMirror). Between that create and the approval, a
-- later credit note or a hand-made journal can reverse some of the bill's VAT; approving the draft
-- then reverses that VAT a second time (SIV3762: JE-2026-26788, then CN-557). approveCreditNote must
-- re-check such a note against the bill, and ONLY such a note: a note raised at its own rate (REST,
-- imports, MCP without mirror_bill) keeps today's behaviour (Hein, 2026-11-13, option A). Nothing on
-- the row could tell the two apart: external_system is the source-system identity (migration 530).
--
-- WHAT. vat_basis TEXT NOT NULL DEFAULT 'rate', CHECK in ('rate', 'mirror_bill', 'mirror_bill_ack').
--   'rate'            tax_amount = subtotal x tax_rate, or as the caller gave it — every existing row
--                     and every path except the two below;
--   'mirror_bill'     set only by the MCP create with mirror_bill: the VAT the bill's posting, reversals
--                     and credit notes left on this share;
--   'mirror_bill_ack' the same, after the caller acknowledged that VAT was already reversed and stated
--                     the amount itself (review round 1): approval re-checks the amount against the bill's
--                     derivable VAT but does not judge the acknowledged journals again.
-- Fixed at create: no path updates it, so the approval digest (R-035) needs no new element, as 892
-- reasoned for gl_account_id. Table-level grants on credit_notes already cover the column.
--
-- vat_ack_matches JSONB, nullable (review round 4): for a 'mirror_bill_ack' note, the heuristic matches
-- the caller acknowledged — [{"journal_entry_id": uuid, "vat_amount": number}, ...]. Approval refuses
-- the note when a match that moves the bill's VAT is not in this list, or moves a different amount: an
-- in-place change (an account merge, a VAT-code edit) can bring a journal into the match set without
-- changing any timestamp. NULL on every other note. Set at create, never updated.
--
-- LOCKS. A constant default is catalogue-only on PG 11+ (no rewrite). ADD COLUMN takes ACCESS EXCLUSIVE
-- on credit_notes and HOLDS it to the end of this migration's transaction, so the VALIDATE below still
-- runs under it: the scan of credit_notes (every existing row is 'rate') blocks readers and writers of
-- the table for its length, bounded by statement_timeout. Acquiring the lock is bounded by lock_timeout.
--
-- Rollback (down SQL), safe at any time; code before this migration never reads the column, and code
-- after it treats a missing value as 'rate' on read but INSERTs it, so roll the code back first:
--   ALTER TABLE public.credit_notes DROP CONSTRAINT IF EXISTS credit_notes_vat_basis_check;
--   ALTER TABLE public.credit_notes DROP COLUMN IF EXISTS vat_ack_matches;
--   ALTER TABLE public.credit_notes DROP COLUMN IF EXISTS vat_basis;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS vat_basis TEXT NOT NULL DEFAULT 'rate';
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS vat_ack_matches JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_notes_vat_basis_check' AND conrelid = 'public.credit_notes'::regclass
  ) THEN
    ALTER TABLE public.credit_notes ADD CONSTRAINT credit_notes_vat_basis_check
      CHECK (vat_basis IN ('rate', 'mirror_bill', 'mirror_bill_ack')) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.credit_notes VALIDATE CONSTRAINT credit_notes_vat_basis_check;

COMMENT ON COLUMN public.credit_notes.vat_ack_matches IS
  'mirror_bill_ack notes only: the heuristic matches the caller acknowledged at create ([{journal_entry_id, vat_amount}]). approveCreditNote refuses when a VAT-moving match is missing from it or moved a different amount.';

COMMENT ON COLUMN public.credit_notes.vat_basis IS
  'How tax_amount was set: rate (subtotal x tax_rate, or as given), mirror_bill (MCP create_credit_note mirror_bill: the bill''s VAT as it stood) or mirror_bill_ack (the same, the caller having acknowledged VAT already reversed and stated the amount). approveCreditNote re-checks mirror_bill notes against the bill.';
