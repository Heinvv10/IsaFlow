-- 677: credit-note allocations, and the status that says "partly consumed".
--
-- WHY A TABLE. Before this, a credit note recorded what it had consumed in a
-- single `credit_notes.applied_amount` column and named the one invoice it was
-- linked to. That shape can only describe a note applied to ONE document, so a
-- note larger than its invoice left the excess stranded: 'applied' notes cannot
-- be applied again, and nothing carried the remainder to the next open bill.
-- FIFO application needs one row per (note, invoice) pair, and `applied_amount`
-- becomes the sum of those rows rather than an independent figure that can
-- silently disagree with them.
--
-- UNIQUE (credit_note_id, invoice_id) is what makes re-application idempotent
-- at the database rather than in a service: a second pass over the same pair
-- raises 23505 instead of double-crediting the invoice.
--
-- amount_allocated > 0 mirrors payment_allocations. A zero row is not a
-- settlement, it is a rounding artefact, and it would make `applied_amount`
-- disagree with the rows it is meant to sum.

CREATE TABLE IF NOT EXISTS credit_note_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL,
  credit_note_id UUID NOT NULL REFERENCES credit_notes(id) ON DELETE CASCADE,
  -- Deliberately NOT a foreign key: it points at customer_invoices for a
  -- customer note and supplier_invoices for a supplier one, and Postgres has no
  -- single FK that can span both. The note's `type` is the discriminator, and
  -- every read here joins through it.
  invoice_id UUID NOT NULL,
  amount_allocated NUMERIC(15,2) NOT NULL CHECK (amount_allocated > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT credit_note_allocations_note_invoice_unique UNIQUE (credit_note_id, invoice_id)
);

-- The aging rewind asks "what did credit notes take off THIS invoice", per
-- invoice, inside a correlated subquery run once per row of the report.
CREATE INDEX IF NOT EXISTS idx_credit_note_allocations_invoice
  ON credit_note_allocations (company_id, invoice_id);
CREATE INDEX IF NOT EXISTS idx_credit_note_allocations_note
  ON credit_note_allocations (credit_note_id);

-- 'partially_applied' — 0 < applied_amount < total_amount. Without it a note
-- that consumed part of its value had to be reported as either 'approved'
-- (which every statement and ledger reader treats as unallocated credit at FACE
-- value, overstating the credit still available) or 'applied' (which they treat
-- as fully consumed, hiding the remainder). Neither is true of a partly
-- consumed note, so the third state is the only honest one.
--
-- Dropped and re-added by name because the original was created inline by
-- migration 202 and so carries Postgres's generated name.
--
-- Guarded rather than a bare DROP + ADD. `ADD CONSTRAINT` raises 42710 when the
-- name is already taken, so the pair is not re-runnable on its own: the drop
-- succeeds, the add fails, and a file re-applied by hand — which is exactly how
-- the disposable schema fixture is kept current — leaves the table with NO
-- status constraint at all if the failure is ignored. The runner applies each
-- file once and refuses on a checksum mismatch, so this cannot happen through
-- it; the guard is for every other way a migration gets run.
DO $$
BEGIN
  ALTER TABLE credit_notes DROP CONSTRAINT IF EXISTS credit_notes_status_check;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'credit_notes'::REGCLASS AND conname = 'credit_notes_status_check'
  ) THEN
    ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_status_check
      CHECK (status::TEXT = ANY (ARRAY['draft', 'approved', 'partially_applied', 'applied', 'cancelled']));
  END IF;
END $$;

-- BACKFILL. Every note that already consumed something did so against the one
-- invoice it is linked to, and `applied_amount` is exactly what it consumed
-- (creditNoteApproveService has capped it at the invoice's outstanding balance
-- since migration 529). Without these rows, cancelling a note approved before
-- this migration would find no allocations and restore nothing — the cancel
-- path reads the rows, not the column.
--
-- THE GUARD IS `NOT EXISTS ON THE NOTE`, NOT `ON CONFLICT`. Once FIFO
-- application is live a note can carry rows for documents its LINK does not
-- name: a note whose linked invoice was already settled allocates nothing to it
-- and places the whole amount elsewhere. `ON CONFLICT (credit_note_id,
-- invoice_id)` does not fire for such a note, because the (note, link) pair is
-- genuinely absent — so a second run of this file would invent a row
-- attributing the note's whole `applied_amount` to a document it never
-- credited, and double the credit on it. Excluding every note that already has
-- ANY allocation row makes the backfill idempotent against that shape.
INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated, created_at)
SELECT cn.company_id, cn.id,
       COALESCE(cn.customer_invoice_id, cn.supplier_invoice_id),
       cn.applied_amount,
       COALESCE(cn.approved_at, cn.created_at, NOW())
FROM credit_notes cn
WHERE cn.applied_amount > 0
  AND cn.status IN ('approved', 'applied')
  AND COALESCE(cn.customer_invoice_id, cn.supplier_invoice_id) IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM credit_note_allocations cna WHERE cna.credit_note_id = cn.id
  );
