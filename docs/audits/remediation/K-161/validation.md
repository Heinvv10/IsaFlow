# K-161 — pipeline mutates captured_documents then returns 409

- **Claim (medium):** the write at `pages/api/accounting/ai-invoice-pipeline.ts:112` commits alongside the conflict response.
- **Disposition:** `false-positive`. The mechanism is real; it is the designed behaviour, not a defect.

## Evidence
- `git show origin/master:pages/api/accounting/ai-invoice-pipeline.ts` lines 112-127: on `dupHit` the route sets `captured_documents.status = 'matched'` and `matched_invoice_id = <the existing invoice>`, then answers `ErrorCode.CONFLICT` with the hit in the body. File unchanged since 5661d6f0.
- `git show origin/master:src/lib/auth/withAuth.ts:224-226`: `const handlerFailed = res.statusCode >= 500;` then `await client.query(handlerFailed ? 'ROLLBACK' : 'COMMIT')`. A 4xx committing is the middleware's explicit, documented contract, not an accident of this route.
- The same shape appears deliberately in the sibling route: `pages/api/accounting/capture/[id]/post.ts:118-125` records `status='failed', error='duplicate'` and then returns 409.
- Disconfirming argument: rolling this write back would discard the only record of the dedupe decision. The document would stay `pending` with no link to the invoice it duplicates, and the 409 body would name an invoice the database does not associate with the document. The write is what makes the conflict actionable.

## Residual concern (belongs to K-155, not here)
The link is only as good as the duplicate decision. Because `findDuplicate` ignores invoice status (K-155) and will fuzzy-match at 0.85 on amount+date alone, a false positive permanently points a captured document at a cancelled or unrelated invoice. Fix K-155 and this write is correct; leave K-155 open and this write faithfully persists a wrong answer. No separate change is warranted under K-161.

## RED test
None written — nothing to fail for the claimed reason.
