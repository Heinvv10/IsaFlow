# K-157 — attachEvidenceToProvisional swallows a SQL error inside the caller's transaction

- **Claim (medium):** the catch hides an error that has already aborted the shared transaction.
- **Corrected trigger:** confirmed, and the consequence is worse than "hidden". The catch at `evidenceAttachmentService.ts:129` returns the no-match shape `{attachedJeId:null, bankTxId:null}` for *any* failure, including the two UPDATEs at lines 101 and 113. Those run on the ALS-bound request client that `withAuth` supplies, and a plain `sql\`\`` failure opens no savepoint — `LazyQuery.run` (`src/lib/neon.ts:96-112`) only calls `assertTxUsable()` and hands the statement to `ctxClient`. Only `sql.transaction` batches get a `SAVEPOINT` (lines 213-247). So the connection is left in PostgreSQL's aborted state (25P02) with `txUnusable` unset, and the caller is told "no match found".
- **Disposition:** `confirmed`.

## Evidence
- Files unchanged between 5661d6f0 and origin/master.
- Reachable trigger: `gl_journal_entries.extraction_confidence` is `numeric(5,4)` (max 9.9999; confirmed against the fixture schema). The value written at line 108 comes from `captured_documents.extracted_data.confidence`, which `captureRouterService.ts:161` stores verbatim from model output with no clamp; `evidenceAttachmentService.ts:51` only checks `typeof === 'number'`. A model answering a percentage (95) rather than a ratio overflows the column with 22003.
- RED: `tests/integration/k157-attach-evidence-poisons-tx.int.test.ts` — 1 failed / 1. Log: `red.log`. Inside an `als.run` request transaction the function swallows the error (`attachThrew` null, `attachResult` the no-match shape) and the next `sql\`SELECT 1\`` fails with code 25P02.
- `commit-tag-probe.log`: PostgreSQL answers `COMMIT` on an aborted transaction with the command tag `ROLLBACK` and **no error**.

## Harm
`pages/api/accounting/capture/[id]/post.ts` calls this at line 197, after creating the supplier invoice (line 133), linking the document (line 159) and marking the event posted (line 165). Every step after the swallow is itself wrapped in a catch — `resolvePendingAlertForInvoice` at 214, `performThreeWayMatch` at 220 — so the handler reaches line 240 and returns **200 with an invoice id and number**. `withAuth` then issues COMMIT, PostgreSQL degrades it to ROLLBACK, and `handlerFailed` is false so nothing is logged as a failure. The user is shown a supplier invoice that was never created; the capture event is still `extracted` and can be posted again.

## Proposed minimal fix
Wrap the body of `attachEvidenceToProvisional` in the repo's existing `withSavepoint` helper so a failure rolls back only its own statements and leaves the request transaction usable, and narrow the catch to log-and-return-nothing only for that contained failure. Separately, clamp the confidence read at line 51 to `[0,1]` before it reaches the numeric(5,4) column. About 5 lines across `evidenceAttachmentService.ts`.

## Historical-data impact
Affected requests committed nothing, so there are no bad rows — there are missing ones, plus users who believe an invoice exists. Look for capture events whose document was never linked despite a posted-looking outcome:

```sql
SELECT ce.id, ce.company_id, ce.received_at, ce.status, cd.id AS document_id,
       cd.extracted_data->'confidence' AS confidence
FROM capture_events ce
JOIN captured_documents cd ON cd.id = ce.captured_document_id
WHERE ce.status <> 'posted'
  AND cd.matched_invoice_id IS NULL
  AND (cd.extracted_data->>'confidence')::numeric > 1;
```
The `> 1` predicate isolates the specific overflow trigger; drop it to see the whole silent-rollback population. Cross-check against the request log, which records every request body.

## Risks
Adding a savepoint changes the failure mode from silent-total-rollback to partial success: the invoice will now commit while the evidence attach did not. That is the intended contract of the "best-effort, non-blocking" comment at line 194, but it means a JE that should have been flipped to evidenced stays `needs_evidence = true` and needs a sweep to catch up.
