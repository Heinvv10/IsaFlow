-- 625 — index supplier_invoices.duplicate_fingerprint the way it is actually queried
--
-- WHAT THIS WAS, AND WHY IT IS NOT THAT ANY MORE
--
-- This migration originally added a UNIQUE index on
-- (company_id, supplier_id, duplicate_fingerprint) so that the migration
-- wizard's `ON CONFLICT DO NOTHING` would actually fire and a re-run of the same
-- source file would be a no-op. A read-only pre-flight probe against production
-- killed that idea outright: the Demo company alone holds five or more groups of
-- 55 to 79 approved or paid supplier invoices that share a single fingerprint.
-- The index could not be built, and the deploy would have aborted before the
-- rsync.
--
-- The fingerprint is not a per-document identity. It is
-- lower(vat_number|invoice_number|total_amount) with the literals 'no-vat',
-- 'no-inv' and '0' substituted for missing parts (migration 412's backfill and
-- captureDeduplicationService.computeFingerprint agree on this), so every row
-- that is missing the same parts collapses onto the same string. It was designed
-- as an advisory signal for `findDuplicate` to REPORT on, and it cannot carry a
-- constraint.
--
-- So: a NON-UNIQUE index, matching how findDuplicate actually probes
-- (captureDeduplicationService.ts — company_id, supplier_id and
-- duplicate_fingerprint, with no deleted_at predicate). The wizard's idempotency
-- now comes from an explicit lookup before the INSERT rather than from a
-- constraint; see migrationApService.ts.
--
-- idx_supplier_invoices_duplicate_fp (migration 412) is KEPT. It leads
-- (company_id, duplicate_fingerprint) without supplier_id, which this index
-- cannot serve, and nothing in this change makes it redundant.
--
-- Whether the fingerprint SHOULD be per-document is a real question, and the
-- degenerate production values are recorded as a register item in
-- docs/audits/remediation/K-015/fix.md. This branch does not change its
-- semantics: rewriting how every duplicate check in the system identifies a
-- document is not a side effect of an import fix.

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier_fingerprint
  ON supplier_invoices (company_id, supplier_id, duplicate_fingerprint)
  WHERE duplicate_fingerprint IS NOT NULL;
