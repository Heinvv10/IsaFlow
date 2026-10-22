-- 914: supplier_payments.batch_id never changes once the row exists.
--
-- A payment joins a batch only by being INSERTed with batch_id (createBatch);
-- no code path, script or function updates the column (census, 2026-10-22:
-- cancel, void, unapply, batch cancel/reverse, supplier merge and the demo and
-- backfill migrations all leave it alone, and no FK on it has an ON DELETE
-- SET NULL action that would). The batch services lock the batch row first and
-- then its members by `WHERE batch_id = $1`, and the batch approval digest and
-- gate read membership the same way. A member re-pointed mid-flight would be
-- locked, approved and paid under one batch while belonging to another, so the
-- database refuses the change instead of trusting every future writer.
--
-- BEFORE UPDATE OF batch_id ... FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW):
-- fires for plain, aliased and UPDATE ... FROM statements, for the UPDATE arm
-- of INSERT ... ON CONFLICT and for MERGE; writing the same value, and every
-- UPDATE of other columns, never reaches the function.
--
-- SQLSTATE 23000 (integrity_constraint_violation), the class's generic code:
-- not 23505 (callers match that to detect a lost race), not 23503/23514
-- (they would read as a missing parent or a failed CHECK).
--
-- Idempotent: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE, ENABLE ALWAYS.

CREATE OR REPLACE FUNCTION public.supplier_payments_batch_id_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'supplier_payments.batch_id is immutable: payment % cannot move from batch % to batch %; batch operations take the batch lock first and then its members (lock order), so membership may only be set when the payment is inserted',
    OLD.id, OLD.batch_id, NEW.batch_id
    USING ERRCODE = '23000';
END;
$$;

DROP TRIGGER IF EXISTS trg_supplier_payments_batch_id_immutable ON public.supplier_payments;
CREATE TRIGGER trg_supplier_payments_batch_id_immutable
  BEFORE UPDATE OF batch_id ON public.supplier_payments
  FOR EACH ROW
  WHEN (OLD.batch_id IS DISTINCT FROM NEW.batch_id)
  EXECUTE FUNCTION public.supplier_payments_batch_id_immutable();

-- ALWAYS, as 692's triggers: session_replication_role = replica must not switch
-- this barrier off for a session.
ALTER TABLE public.supplier_payments ENABLE ALWAYS TRIGGER trg_supplier_payments_batch_id_immutable;
