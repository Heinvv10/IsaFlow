# R-105: a manual expense claim line did not claim its source document

## What was found
`POST /api/accounting/expense-claims` (create) and `POST /api/accounting/expense-claims/[id]` (add a line) wrote `lines[].sourceDocumentId` into `expense_claim_lines` with no check. The capture path (`capture/[id]/post-expense`) stamps `captured_documents.posted_at` before it creates its claim; the manual paths did not. On master 4db98a9ba, through the real routes (withAuth, app_user, RLS), each of these returned 201 or 200 (`red.log`):

- a slip already posted through capture went on a manual claim, so the same input VAT could be claimed twice;
- a slip an operator rejected was accepted;
- **another company's `captured_documents` id was accepted and stored on this company's claim.** The FK check on `source_document_id` runs without RLS;
- a fresh slip was never claimed, so a second claim could take it;
- the same slip on two lines of one claim was accepted.

## Fix
`src/modules/accounting/services/expense/claimSourceDocuments.ts`:
- **`claimLineSourceDocuments(companyId, lines)`** takes the capture posting claim (`posted_at`, the same fence as `claimCapturedDocumentForPosting`) on every line's source document, **in one statement**. It locks the eligible set and updates only when that set is complete: all slips are claimed, or none are. This matters because `withAuth` COMMITs on a 4xx, so a line-by-line claim that refused the second slip would commit the first slip's stamp with no claim behind it. The statement is company-scoped itself, not left to RLS.
  - Lines written before this fix never stamped `posted_at`, so the claim also refuses a slip that is already on a LIVE claim line (any status except rejected or cancelled), whatever its `posted_at` says.
  - Ids are lower-cased first, because Postgres returns uuids lower-case.
  - A duplicate slip, or one that is missing, foreign, already posted, on another live claim or rejected, throws `ClaimSourceDocumentError` before anything is written. The routes answer it with a 400.
  - The lock wait is bounded at 5s, like the capture posting paths' (`captureRowLock`). A timeout or deadlock is the `busy` refusal, answered 409 ("retry in a moment"). The lock error has aborted the transaction, so the 4xx commits nothing.
  - If the statement ever stamps some slips and not all (only possible without the lock), it throws a plain error. The request then rolls back, because a 4xx would COMMIT the partial stamps.
- **`createClaim`** calls it before its first write. `post-expense` already claims its slip, so it passes `sourceDocumentsClaimed: true`.
- **`addLine`** calls it before inserting the line.
- **Release:**
  - `deleteLine` releases the slip of the line it deleted.
  - The draft-claim DELETE route locks the claim row, reads its slips, deletes, then releases them. The lock makes the read complete: a concurrent add-line's INSERT needs a key-share lock on the claim row, so it either finished first (and is read) or fails on the deleted parent (and its claim rolls back).
  - Both go through `releaseCapturedDocumentPostingClaim`, which keeps any slip that something live in the ledger still references.

No migration.

## Evidence
All runs are on the r112 fixture.
- **RED** (`red.log`): 7 of 9 fail on master's code. The two delete-release tests passed there vacuously, because nothing was ever claimed.
- **GREEN:** `tests/integration/r105-expense-claim-source-document.int.test.ts`, 16 of 16:
  - refusals for a posted (in any id case), a rejected, a foreign and a repeated slip, and for a slip on a live legacy line that never claimed it. The same slip is free again once that claim is rejected;
  - all or nothing: one refused line leaves the other slip unclaimed and no claim row;
  - add-line claims its slip, and refuses a posted one;
  - line delete and draft-claim delete give the slip back;
  - the claim's own company filter, on a connection RLS does not narrow;
  - races on two real connections:
    - a second claim on one slip waits, then is refused;
    - a two-slip claim racing a claim on one of its slips stamps neither, even when its refusal is COMMITted;
    - a held lock gives `busy` after 5s instead of hanging;
    - the draft-claim delete waits for a concurrent add-line and sees its slip.
- **Capture path unchanged:** `k072-post-expense-claim-vat`, `k072-claim-vat-classification`, `k072-receipt-vat-unread`, `r058-capture-post-double-post` and `k072-draft-claim-release` pass, 55 of 56.
  - The one failure, "migration 672's backfill agrees with the release", fails identically on master 2d69e30d9 with `must be owner of table captured_documents`. It is a fixture-role problem, not this change.
- **Mutations** (`mutations.log`): 15 of 15 go red.
  - Claim removed from create or from add-line.
  - Company filter removed. This one was not caught at first, because RLS hides the foreign row on the route; the service-level test was added for it.
  - All-or-nothing count removed.
  - Duplicate check removed.
  - `posted_at` predicate removed.
  - `rejected` predicate removed.
  - Release removed from line delete or from claim delete.
  - `post-expense` claiming twice.
  - Round 1 added three:
    - the claim's `FOR UPDATE` removed;
    - the lock wait unbounded;
    - the delete's claim-row lock removed.
  - The adversarial round added two:
    - the live-claim-line check removed;
    - ids not lower-cased.

## Review round 1
| Finding | Fix |
|---|---|
| MEDIUM (general): the claim's `FOR UPDATE` was untested. Removing it stayed green, and two connections then both claimed. | Race tests. Without the lock, a two-slip claim could also stamp PART of its set and COMMIT that on the 4xx; a partial stamp is now an error that rolls back. M11 goes red. |
| LOW: the draft-claim DELETE read its slips without locking the claim, so a concurrent add-line's slip could be stranded. | The claim row is locked first (`lockClaimReadSourceDocumentIds`). Race test; M15 goes red. |
| LOW: the lock wait was unbounded. | 5s `lock_timeout`, then `busy` → 409. M14 goes red. |
| LOW: `claimSourceDocumentIds` read too much like `claimLineSourceDocuments`. | Renamed `lockClaimReadSourceDocumentIds`. |
| LOW: `expenseClaimService.ts` over 300 lines. | Pre-existing (554 on master). Not split here; see below. |
| LOW: R-105's `affectedPaths` was wrong in backlog.json. | Corrected. |

## Review round 1 (adversarial, on e7098d1ad)
| Finding | Fix |
|---|---|
| MEDIUM: a slip on a live line written before this fix (posted_at NULL) could go on a second live claim; the repro gave 201 with the slip on 2 lines. | The claim refuses a slip on any live claim line (`on_claim`). Test; M16 goes red. |
| LOW: a claim DELETE racing an add-line could strand a claimed slip. | Already fixed in the general round (claim-row lock, M15). |
| LOW: an upper-case uuid got "not found" instead of "already posted". | Ids lower-cased. Test; M17 goes red. |
| LOW: a released slip keeps status 'matched', so the inbox shows it as settled; the docs said it "goes back to the capture inbox". | The docs now say it can be posted again and keeps 'matched'. The status is left alone: the shared `releaseCapturedDocumentPostingClaim` behaves the same after `rejectClaim` on master, and changing it touches every capture path. See Not covered. |

## For Hein (read-only on prod): what already exists
```sql
-- Lines pointing at another company's captured document.
SELECT ecl.company_id, ecl.claim_id, ecl.source_document_id, cd.company_id AS document_company
FROM expense_claim_lines ecl JOIN captured_documents cd ON cd.id = ecl.source_document_id
WHERE cd.company_id <> ecl.company_id;

-- One slip on more than one live claim line.
SELECT ecl.company_id, ecl.source_document_id, COUNT(*) AS lines
FROM expense_claim_lines ecl JOIN expense_claims ec ON ec.id = ecl.claim_id
WHERE ecl.source_document_id IS NOT NULL AND ec.status NOT IN ('rejected','cancelled')
GROUP BY 1, 2 HAVING COUNT(*) > 1;

-- A slip on a live claim that ALSO produced a live capture journal or supplier invoice (a second input-VAT claim).
SELECT ecl.company_id, ecl.claim_id, ec.status, ecl.source_document_id, ecl.vat_amount
FROM expense_claim_lines ecl JOIN expense_claims ec ON ec.id = ecl.claim_id
WHERE ec.status NOT IN ('rejected','cancelled') AND ecl.source_document_id IS NOT NULL
  AND (EXISTS (SELECT 1 FROM gl_journal_entries je WHERE je.source_document_id = ecl.source_document_id
                 AND je.company_id = ecl.company_id AND je.source = 'auto_expense_receipt' AND je.reversed_at IS NULL)
    OR EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.source_document_id = ecl.source_document_id
                 AND si.company_id = ecl.company_id AND si.status <> 'cancelled'));

-- Slips on live manual lines that were never claimed (posted_at NULL). A later capture post would double them.
SELECT ecl.company_id, ecl.source_document_id FROM expense_claim_lines ecl
JOIN expense_claims ec ON ec.id = ecl.claim_id JOIN captured_documents cd ON cd.id = ecl.source_document_id
WHERE ec.status NOT IN ('rejected','cancelled') AND cd.posted_at IS NULL;
```
If any query returns rows, they need an accountant's decision. They are not repaired here.

## Not covered
- **R-070's recommended backstop**, a partial unique index on `expense_claim_lines(source_document_id)`, is not built. It needs the second query above to come back empty on prod first, or the index will not build.
- **The add-line route's catch-all answers 400** for any other error, including one after a write (R-060's class). That was already the case and is unchanged here.
- **A released slip keeps `status = 'matched'`** (the inbox reads that as settled). That is also true on master after a claim rejection or cancel (`rejectClaim`'s comment says the slips "go back to the capture inbox"; on screen they do not). Restoring the status belongs in `releaseCapturedDocumentPostingClaim`, which every capture path shares. Not changed here.
- **`expenseClaimService.ts` was already over the 300-line cap** (554 lines on master; 572 now). The new logic lives in its own module. The service gained only the call sites, and splitting it is left out of this fix.
