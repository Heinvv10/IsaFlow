# R-107 — attaching a slip to a provisional journal claims it

## Defect

`POST /api/accounting/provisional/[jeId]/attach` names the captured slip that evidences a
bank-first provisional journal. That journal is already posted (DR expense / VAT, CR bank,
`postProvisional`), so the slip is spent: a second journal from it expenses the same bank line
again and claims the input VAT twice. The route never took the capture posting claim
(`captured_documents.posted_at`, migration 672), so the slip stayed postable through every
capture route.

It was dormant. The route selected `source_document_hash` and `extraction_confidence` from
`captured_documents`, which has neither (they are `gl_journal_entries` / `supplier_invoices`
columns, migration 409; the slip's hash is `raw_bytes_sha256`, migration 410, and its confidence
is `extracted_data->>'confidence'`). Every call raised 42703 and `withAuth` rolled it back.
Correcting the columns alone would have woken the double post — measured, see `red.log` stage 2.

## Measured (red.log)

- Stage 1, master route code: 12 of 13 tests red, every attach a 500 `column "source_document_hash" does not exist`.
- Stage 2, master code with ONLY the two columns corrected: the slip is not claimed;
  `receipt-to-journal` then answers 200 and books a second journal for it; two concurrent
  attaches of one slip both win (200, 200); an already-posted and a rejected slip are accepted;
  the inbox's confirm is accepted on an attached slip.

## Fix

`src/modules/accounting/services/capture/provisionalEvidenceAttach.ts` (the route is now a thin
shell that validates both ids as uuids and maps the result):

1. Locks, in order: the bank line(s) with `provisional_je_id = jeId` (`lockBankTransactionForUpdate`),
   then the journal (`FOR UPDATE`, 5s bound), then the document (`lockCapturedDocumentForUpdate`).
   Bank → journal is the canonical order (`services/bank/.claude.md`); the document is last,
   matching `reverseJournalEntry` (journal, then the document's release). The capture post paths
   take the other order; see review round 1.
2. Refuses, before any write: journal not found (404), reversed (400), already evidenced (400);
   document not found / other tenant (404).
3. Claims the slip with `claimCapturedDocumentForPosting` — one predicated UPDATE, so a claimed or
   rejected slip is refused (400) with nothing written.
4. Then the writes: bank line `status='matched'`, journal evidenced (hash from `raw_bytes_sha256`,
   confidence from `extracted_data` only when in [0, 1] — the journal column is NUMERIC(5,4)).
5. Lock contention (55P03 / 40P01, either typed lock error) answers 409.

The claim's release (`capturePostingClaimRelease.ts`): both `releaseCapturedDocumentPostingClaim`
and `releaseUnpostedCaptureClaim` now treat an unreversed journal the slip EVIDENCES
(`evidenced_at IS NOT NULL AND reversed_at IS NULL`) as live. So confirm/reject in the capture
inbox and a supplier-invoice cancel cannot free a slip a provisional journal stands on, and the
inbox's refusal is still decided before it discards drafts. Reversing the provisional journal
releases it (`reverseJournalEntry` already calls the release). `evidenced_at` rather than
`source = 'auto_bank_recon'`: bank allocation journals copy an invoice's `source_document_id`
(`bankAllocationService`) and are not evidence of the slip.

### Review round 1 (rev-r107-general)

- **MEDIUM — the lock order is not total.** `capture/[id]/post` (through `capturePostFollowUps`) and
  `ai-invoice-pipeline` lock and claim the slip, then the automatic `attachEvidenceToProvisional`
  updates the bank line and the journal: slip → bank → journal, the reverse of the manual attach.
  It cannot be ordered away (moving the slip first in the manual attach inverts it against
  `reverseJournalEntry`, journal → slip), so it is made safe: the automatic attach now runs in its
  own `withSavepoint`. When the post is the 40P01 victim only the attach rolls back and the post
  commits. Before, the swallowed deadlock left the request transaction aborted, the route answered
  200, and withAuth's COMMIT was a silent ROLLBACK of the invoice (measured, red.log round 1: 25P02).
  This also closes K-157 (the same swallow, for any SQL error). When the manual attach is the
  victim it answers 409 with nothing written.
- The automatic attach's journal UPDATE now carries `AND needs_evidence = true AND reversed_at IS
  NULL` and throws on 0 rows (rolling back its bank UPDATE): its match is read unlocked, and it used
  to overwrite a manual attach that committed while it waited (measured, red.log round 1).
- LOW: a bank line unlinked while the attach waited for its lock is not written: the UPDATE re-checks
  `provisional_je_id` after the lock (test: the unlinked-line case; mutation M19). A line cannot be
  linked meanwhile — `postProvisional` links only the journal it just created.
- LOW: the journal lock uses `captureRowLock.lockWithTimeout` (exported) instead of a copy.
- Test: `tests/integration/r107-auto-attach-savepoint.int.test.ts` (2).

### Review round 1 (rev-r107-adversarial)

- MEDIUM: the same cycle as above, measured through `ai-invoice-pipeline` (a 200 with an approved
  invoice id and 0 `supplier_invoices` rows). Closed by the savepoint above.
- LOW: `reverseJournalEntry` released on the `source_document_id` it read BEFORE its claim; an
  attach that committed while the claim waited was missed, and the slip stayed claimed. It now
  re-reads the column after the claim. Test: "a reversal racing an attach" in
  `r107-provisional-attach-release.int.test.ts` (red.log round 1).

Not in scope: a byte-identical re-upload of the slip is a different `captured_documents` row
and is not fenced by this claim — that is R-088 (content de-duplication).

## Tests

- `tests/integration/r107-provisional-attach-claim.int.test.ts` (10) and
  `tests/integration/r107-provisional-attach-release.int.test.ts` (9), shared fixture
  `r107-provisional-attach.helpers.ts`: real routes (`provisional/[jeId]/attach`,
  `receipt-to-journal`, `document-capture-action`), withAuth, app_user, RLS.
- `tests/unit/services/capture/provisionalAttachRouteLockOrder.test.ts` pins the lock / claim /
  write order.
- Mutations: 25 of 25 killed (`mutations.log`; M10 and M19 initially survived and are killed by the
  pre-DELETE refusal test and the unlinked-bank-line test added for them).

## Side finding (registered as R-127, not fixed here)

The AUTOMATIC attach (`evidenceAttachmentService.attachEvidenceToProvisional`, called from
`capture/[id]/post` via `capturePostFollowUps` and from `ai-invoice-pipeline`) runs after a
supplier invoice has been created from the same slip, and flips the provisional journal to
evidenced while the invoice stays live. Read, not measured: the provisional journal expenses the
bank line (DR expense / CR bank) and the invoice expenses it again (DR expense / CR AP) once
approved, and the AP it raises is never settled by that bank line. The release predicate change
here keeps such a slip claimed while the provisional journal stands, which is the safe direction.

## Census SQL for Hein (prod, read-only — agents never run this)

```sql
-- 0. Did the manual route ever work on prod? It needs these two columns on captured_documents.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'captured_documents' AND column_name IN ('source_document_hash','extraction_confidence');

-- 1. Provisional journals evidenced by a slip, and whether that slip is claimed.
SELECT je.company_id, je.id AS je_id, je.entry_number, je.posting_agent, je.evidenced_at,
       cd.id AS doc_id, cd.posted_at, cd.status
  FROM gl_journal_entries je
  JOIN captured_documents cd ON cd.id = je.source_document_id AND cd.company_id = je.company_id
 WHERE je.evidenced_at IS NOT NULL AND je.reversed_at IS NULL
 ORDER BY je.company_id, je.evidenced_at;

-- 2. Double posts: a slip evidencing a live provisional journal that ALSO produced another live
--    ledger row (capture journal, supplier invoice, or expense-claim line).
SELECT je.company_id, cd.id AS doc_id, je.id AS provisional_je,
       (SELECT COUNT(*) FROM gl_journal_entries x
         WHERE x.source_document_id = cd.id AND x.company_id = cd.company_id
           AND x.source = 'auto_expense_receipt' AND x.reversed_at IS NULL) AS capture_journals,
       (SELECT COUNT(*) FROM supplier_invoices si
         WHERE si.source_document_id = cd.id AND si.company_id = cd.company_id
           AND si.status <> 'cancelled') AS supplier_invoices,
       (SELECT COUNT(*) FROM expense_claim_lines l
         WHERE l.source_document_id = cd.id AND l.company_id = cd.company_id) AS claim_lines
  FROM gl_journal_entries je
  JOIN captured_documents cd ON cd.id = je.source_document_id AND cd.company_id = je.company_id
 WHERE je.evidenced_at IS NOT NULL AND je.reversed_at IS NULL
   AND (EXISTS (SELECT 1 FROM gl_journal_entries x WHERE x.source_document_id = cd.id
                  AND x.company_id = cd.company_id AND x.source = 'auto_expense_receipt' AND x.reversed_at IS NULL)
     OR EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.source_document_id = cd.id
                  AND si.company_id = cd.company_id AND si.status <> 'cancelled')
     OR EXISTS (SELECT 1 FROM expense_claim_lines l WHERE l.source_document_id = cd.id
                  AND l.company_id = cd.company_id));

-- 3. Slips a live provisional journal stands on that are still UNCLAIMED (postable after deploy).
--    If any, a one-off backfill (Hein's call, run in a transaction):
--    UPDATE captured_documents cd SET posted_at = je.evidenced_at, updated_at = NOW()
--      FROM gl_journal_entries je
--     WHERE je.source_document_id = cd.id AND je.company_id = cd.company_id
--       AND je.evidenced_at IS NOT NULL AND je.reversed_at IS NULL AND cd.posted_at IS NULL;
SELECT je.company_id, COUNT(*) AS unclaimed_evidence
  FROM gl_journal_entries je
  JOIN captured_documents cd ON cd.id = je.source_document_id AND cd.company_id = je.company_id
 WHERE je.evidenced_at IS NOT NULL AND je.reversed_at IS NULL AND cd.posted_at IS NULL
 GROUP BY je.company_id;
```

### Review round 2 (rev-r107-general, SHIP with LOWs — all fixed)

- The unlinked-line test pins the `provisional_je_id` re-check; the extra `id = ANY(locked)` predicate
  it did not pin guarded an impossible case and was removed.
- `journalEntryReversal.test.ts`'s default mock answers only the post-claim re-read; any other
  unqueued statement fails the case.
- Dead `provisional_je_id` field removed from the lock-order unit mock.

### PR-level /review (#512, APPROVED with two LOWs — both fixed)

- The "nothing links a line to an existing provisional journal" invariant the unlocked peek relies on
  is now pinned by a ratchet, `tests/unit/guards/provisionalLinkWriterCensus.test.ts` (only
  `postProvisional` may set `provisional_je_id` to a value; mutation M20).
- The not_found result carries its own id, so the route cannot pair the wrong id with the resource.
- Adversarial re-review of the census: the narrow SET regex missed tuple SETs, quoted or
  schema-qualified names, ON CONFLICT DO UPDATE, MERGE, the `bank_transactions_posted` view, and
  files outside src/ and pages/. A coarse rule now requires every tracked file under src/, pages/
  and scripts/ (fix scripts and SQL migrations included) that names the column and writes the table
  in any of those shapes to be classified (mutation M21). A runtime-built column name remains out of
  reach of any source-text census, and the header says so.
- Second census round: four more evasions (INSERT column list or tuple SET inside an already-listed
  file, `UPDATE ONLY`, a `.sh`/`.cjs` file). A pattern for "a link" can always miss one more shape,
  so the census is now fail-closed: it pins, for each listed file, every line that mentions
  `provisional_je_id`. Any change to how those files use the column goes red; `ONLY` is recognised;
  every tracked text file under src/, pages/ and scripts/ is scanned. All four evasions killed.
