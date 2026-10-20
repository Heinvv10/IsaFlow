-- 898: one live Netcash submission per supplier payment batch (audit 2026-10-18, AP-01).
--
--   netcash/submit in batch mode sent the batch to Netcash and only then recorded it, so a double-click, a second
--   tab, or a retry after the 30 s timeout (recorded 'failed' although Netcash may have accepted the file) paid every
--   supplier a second time. The route now inserts a claim row BEFORE the send and settles it after; this migration is
--   the schema under it:
--     batch_id  the supplier_payment_batches row a submission sends (NULL: a raw payments[] submission, or history).
--     'unknown' a new status: the request left but Netcash's answer is indeterminate (timeout, network error, an
--               unparseable or 5xx answer). It keeps the batch claimed: the batch may have been paid, so it is not
--               resubmitted until someone has checked Netcash.
--     the partial UNIQUE index lets a batch have at most one submission that is not 'failed'. 'failed' (Netcash
--     definitely rejected it) leaves the index, so a rejected batch can be sent again.
--   The column is new and empty, so the foreign key is plain (no NOT VALID). It is NO ACTION: a batch that has a
--   submission cannot be deleted out from under that record (nothing in the app deletes batches; a company delete
--   cascades both tables in one statement).
--
-- RLS and grants are unchanged: tenant_isolation (membership) and app_user's table-level SELECT/INSERT/UPDATE/DELETE
-- already cover a new column.
--
-- Rollback:
--   DROP INDEX IF EXISTS public.uq_netcash_submissions_live_batch;
--   ALTER TABLE public.netcash_submissions DROP CONSTRAINT IF EXISTS netcash_submissions_status_check;
--   (no 'unknown' rows may exist: UPDATE … SET status = 'failed' WHERE status = 'unknown' first)
--   ALTER TABLE public.netcash_submissions ADD CONSTRAINT netcash_submissions_status_check CHECK (status IN
--     ('pending','submitted','processing','completed','failed'));
--   ALTER TABLE public.netcash_submissions DROP COLUMN IF EXISTS batch_id;
-- Locks: ACCESS EXCLUSIVE on netcash_submissions (a small table) for the column, the CHECK swap and the index;
-- SHARE ROW EXCLUSIVE on supplier_payment_batches for the foreign key. All catalogue-fast: the column is empty.

ALTER TABLE public.netcash_submissions
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES public.supplier_payment_batches(id);

ALTER TABLE public.netcash_submissions DROP CONSTRAINT IF EXISTS netcash_submissions_status_check;
ALTER TABLE public.netcash_submissions ADD CONSTRAINT netcash_submissions_status_check
  CHECK (status IN ('pending','submitted','processing','completed','failed','unknown'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_netcash_submissions_live_batch
  ON public.netcash_submissions (company_id, batch_id)
  WHERE batch_id IS NOT NULL AND status <> 'failed';
