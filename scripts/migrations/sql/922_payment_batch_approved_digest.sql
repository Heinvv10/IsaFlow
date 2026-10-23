-- Migration 922: what an approved supplier payment batch was approved FOR.
--
-- With payment_batch approval enforcement OFF, approving a batch was a status
-- flip and nothing recorded its content: a payee's bank details (or any other
-- line the batch digest covers) could change afterwards, and eft-generate /
-- netcash/submit / process still paid the live details nobody approved. With
-- enforcement on, the approval gate already refuses that (APPROVAL_STALE).
--
-- approveBatch now stores approval_document_digest(company, 'payment_batch',
-- id) — the same digest the approval gate compares — in the UPDATE that sets
-- 'approved'; the bank file, the Netcash send and process refuse a batch whose
-- current digest differs (ap/batchApprovedDigest), whatever the enforcement
-- switch says. NULL: approved before this column existed — allowed, with a
-- warning. No backfill (Hein, 2026-10-23): today's digest is not evidence of
-- what was approved then.
--
-- Additive only. No grant: app_user's table-level UPDATE on
-- supplier_payment_batches covers the new column.

ALTER TABLE public.supplier_payment_batches ADD COLUMN IF NOT EXISTS approved_digest TEXT;

COMMENT ON COLUMN public.supplier_payment_batches.approved_digest IS
  'approval_document_digest(company_id, ''payment_batch'', id) when the batch was last approved; NULL = approved before migration 922 (or never approved).';
