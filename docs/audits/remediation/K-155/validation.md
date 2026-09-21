# K-155 — capture duplicate detection ignores supplier-invoice status

- **Claim (medium):** a cancelled invoice permanently blocks re-capture of the same document.
- **Corrected trigger:** confirmed, and broader than stated. `findDuplicate` (`captureDeduplicationService.ts:68` exact, `:101` fuzzy) filters on `company_id + supplier_id` plus fingerprint or amount/date only. Neither query excludes `status = 'cancelled'` (written by `supplierInvoiceWorkflowService.ts:315`) nor `deleted_at IS NOT NULL` (written by `softDeleteService.ts:105`).
- **Disposition:** `confirmed`.

## Evidence
- Files read with `git show origin/master:...`; unchanged since 5661d6f0.
- Reachability: `autoPublishGateService.decide` calls `findDuplicate` first (line 50) and returns `duplicate_blocked`; `pages/api/accounting/capture/[id]/post.ts:117-125` then marks the capture event `failed`/`duplicate` and answers 409. `pages/api/accounting/ai-invoice-pipeline.ts` calls `findDuplicate` directly and answers 409 the same way. There is no override parameter on either route.
- RED: `tests/integration/k155-duplicate-detection-ignores-status.int.test.ts` against the disposable PostgreSQL fixture — 2 failed / 1 passed. Log: `red.log`. The passing case is the guard that a live invoice must still block.

## Harm
The normal correction loop is closed off. A user who cancels a mis-captured supplier invoice and re-uploads the corrected document is refused with 409 forever, because the cancelled row still owns the fingerprint. The 409 body names an invoice that no longer exists as a payable.

## Proposed minimal fix
Add `AND deleted_at IS NULL AND status <> 'cancelled'` to both SELECTs in `captureDeduplicationService.ts` (lines 68-76 and 101-111). Two lines. Consider surfacing a cancelled near-match as a warning in the `route_review` path rather than dropping it silently, but that is optional and not required to unblock re-capture.

## Historical-data impact
No rows were written incorrectly — the defect denies work rather than corrupting it. The recoverable population is capture events parked as duplicates against a dead invoice:

```sql
SELECT ce.id, ce.company_id, ce.subject, si.id AS blocking_invoice, si.status, si.deleted_at
FROM capture_events ce
JOIN captured_documents cd ON cd.id = ce.captured_document_id
JOIN supplier_invoices si ON si.id = cd.matched_invoice_id
WHERE ce.status = 'failed' AND ce.error = 'duplicate'
  AND (si.status = 'cancelled' OR si.deleted_at IS NOT NULL);
```
Those events can be re-posted after the fix. Note `softDeleteService.ts:268` purges soft-deleted invoices after 5 minutes, so the `deleted_at` half of the population is small; the `cancelled` half is permanent.

## Risks
Cancellation becomes a way to re-admit a genuinely duplicated invoice. That is the intended behaviour of a cancel, and the fingerprint still blocks re-capture against every live invoice, but it removes one incidental barrier.
