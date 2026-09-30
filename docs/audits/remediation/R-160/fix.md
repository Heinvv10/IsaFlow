# R-160: ai-invoice-pipeline leaves an auto-approved bill with no provisional approved with no journal

The sibling of R-131 (`capture/[id]/post`, PR #572), reported by the R-131 fixer.

## What was found (reproduced on origin/master 7c49109f5, 2026-09-30)
On the disposable fixture (`isaflow-fixture-r160-goal`, cloned from r159 at migration 716), through the real `withAuth` route as app_user. Two clean, low-value slips from a matched supplier, no bank-first provisional:

```
REPRO route=200 approvalRoute=auto_approve bill={"status":"approved","total":402.5,"gl_journal_entry_id":null,"items":1}
REPRO route=200 approvalRoute=auto_approve bill={"status":"approved","total":115,"gl_journal_entry_id":null,"items":0}
REPRO AP subledger=517.5 AP in GL=0
```

1. The first slip has its line and is auto-approved, but it has no journal: R402.50 owing in the AP subledger and nothing in the GL.
2. The second slip's only extracted line had quantity 0. The route skipped it and inserted the bill anyway, with **no lines**. That is R-131's other defect, and such a bill cannot post a balanced journal at all.
3. A document with a total of 0 became a R0 bill. The RED run shows it answering 200.

## Root cause
- `pages/api/accounting/ai-invoice-pipeline.ts` called `attachEvidenceAndSettleApproved` without `postUnattached`. Without that flag, an auto-approved invoice is posted only when it evidences a bank-first provisional (R-127). Every other auto-approved bill stayed `approved` with no journal.
- The route inserted its line items in an inline loop:
  - It skipped a line with quantity ≤ 0 or a negative unit price and inserted the bill regardless, so skipping every line left a bill with none.
  - It never refused a zero total.
  - It synthesised its "As per invoice" line from `subtotal ?? totalAmount`, so a document with VAT but no subtotal put the VAT-inclusive total on the line.
  - Its lines carried no account and no `vat_classification`.

## Fix
- **`postUnattached: true`** is now passed to `attachEvidenceAndSettleApproved`, as `capturePostFollowUps` does since R-131. An auto-approved bill that evidences no provisional is posted through `postSupplierInvoiceToGL`. If its journal cannot post (a closed fiscal period, a filed VAT period, a missing `payable` role), the bill goes back to draft with "Auto-approval withdrawn: its journal could not be posted (…)" in its notes. The response then says `draft` / `manual_review`, through the existing `settlementRefused` branch. Every caller of `attachEvidenceAndSettleApproved` now passes the flag.
- **Line planning: R-131's module is reused, not copied.** The inline loop is replaced by `captureBillLines.planCaptureBillLines` + `insertCaptureBillLines`. Hein's R-131 decision applies:
  - Extracted items are used as read.
  - With none, ONE line is built from net (total − VAT) and VAT, on the supplier coding rule's account (`getRule`), else the company `default_expense`.
  - No total, no account, or an extracted line `assertSupplierInvoiceLines` refuses → 400, nothing written.
- **No capture-event account.** The pipeline is keyed on the document and reads no capture event. An event gets a `resolved_gl_account_id` only when it is posted as an expense (`post-expense`, petty cash), and both of those claim the document first, so any document this route can still post has no event account.
- **Where the plan runs.** It runs after the approval decision and **before** `claimCapturedDocumentForPosting`, the last point where a 4xx commits nothing, because `withAuth` COMMITs a 4xx.
- **Where the lines are inserted.** Straight after the bill, **before** `raiseUnattendedApproval`, as before. The request's stored digest (`approval_document_digest()`, migration 708) hashes them.
- **Behaviour change.** A slip with an unusable line (quantity ≤ 0, or a negative price such as a discount line) used to become a bill with that line silently dropped. It is now a 400 naming the line, as `capture/[id]/post` has answered since R-131.

## Gates that still hold
- `unattendedPostingGate.refusesUnattendedApproval`, `approvalUnattended.unattendedBillStatus` / `raiseUnattendedApproval`, `captureRowLock` (lock, `refusalForPosting`, claim), `findDuplicate` + `computeFingerprint`: all unchanged and in the same order. The only addition is a read-only plan before the claim.

| Suite (fixture, `--no-file-parallelism`) | Result |
|---|---|
| `r160-ai-pipeline-posts`, `r131-capture-post-lines`, all `r127-*`, `r035-pr2-unattended`, `k072-capture-fourth-route`, `k072-capture-vat-unread`, `k072-vat-declaration`, `k072-capture-posting-fence`, `k072-draft-claim-release`, `k072-claim-vat-classification`, `r058-capture-post-double-post`, `r107-auto-attach-savepoint`, `r088-receipt-content-dedupe`, `r088-evidence-attach-race`, `r088-content-fence-routes`, `r088-evidence-attach-check`, `r-032-l5-approval-routes` | 27 files, 260 tests passed |
| Unit: `tests/unit/services/capture`, `tests/unit/services/core`, `capturePostFingerprint` | 47 files, 572 tests passed |

Test changes needed by the fix:
- `k072-capture-fourth-route`: its fixture labelled the AP account `accounts_payable`, which is not a system role. Its auto-approved pipeline bill therefore could not post and was withdrawn to draft. The account now carries the `payable` role, the same change R-131 made to `k072-capture-posting-fence`.
- `r035-pr2-unattended`: gains the pipeline twin of R-131's decided-request test.

## Tests (real PG, through the route, app_user with withAuth GUCs)
`tests/integration/r160-ai-pipeline-posts.int.test.ts`. On 7c49109f5, 7 of the 8 fail; the tenant case passes on master.

| Test | Proves | Red on master |
|---|---|---|
| extracted line items: the auto-approved bill, with no provisional, posts a balanced journal | items match; DR 350 expense + 52.50 VAT = CR 402.50 AP; AP subledger = GL | `the approved bill carries a journal: expected null not to be null` |
| no extracted lines, no rule: ONE line on the company default_expense, balanced | one line, net + VAT, on `default_expense`; balanced | `toMatchObject` (uncoded line) |
| no extracted lines: ONE line on the supplier coding rule's default account, balanced | the rule's account | `toMatchObject` |
| no extracted lines and no account anywhere: 4xx, and nothing is inserted or claimed | 400; no bill; document `pending`, unclaimed, unlinked | `expected 200 to be 400` |
| every extracted line unusable: 4xx, never a bill with no lines | 400 "Extracted line item refused"; nothing written | `expected 200 to be 400` |
| no total: 4xx, and nothing is inserted or claimed | 400; nothing written | `expected 200 to be 400` |
| an auto-approved bill whose journal cannot post goes back to draft, off AP, and says so | filed VAT period → draft, no journal, note, response `draft`/`manual_review`, AP totals unchanged | `expected { status: 'approved' … } to match { status: 'draft' }` |
| another company's document is refused, and nothing is inserted | 404; nothing written | passes on master |

Also: `r035-pr2-unattended` › "ai-invoice-pipeline: the request it raises, once approved, lets the bill approve and post".

## Mutation table
Each mutation was applied to the file, the named test was run, and the file was restored from a scratch backup (`cmp` checked).

| # | Guard removed | Named test | Red on |
|---|---|---|---|
| M1 | `postUnattached: true` | extracted line items: … posts a balanced journal | `the approved bill carries a journal: expected null not to be null` |
| M2 | `insertCaptureBillLines` call | extracted line items: … posts a balanced journal | `expected [] to deeply equal [ …(2) ]` |
| M3 | plan refusal ignored (bill inserted with no lines) | no account anywhere / every extracted line unusable / no total | `expected 200 to be 400` (all three) |
| M4 | `getRule` → `null` (no rule account) | ONE line on the supplier coding rule's default account | `toMatchObject` on `gl_account_id` |
| M5 | plan refusal moved after `claimCapturedDocumentForPosting` | the three 4xx tests | `expected { status: 'matched', posted_at: … } to deeply equal { status: 'pending', posted_at: null, … }` |
| M6 | lines inserted after `raiseUnattendedApproval` | r035-pr2 › ai-invoice-pipeline: the request it raises, once approved… | `expected 409 to be 200` (the stored digest hashed no lines) |
| M7 | response ignores `settlementRefused` | an auto-approved bill whose journal cannot post… | `expected 'approved' to be 'draft'` |
| M8 | `company_id` filter in `lockCapturedDocumentForUpdate` | another company's document is refused | **stays green**: app_user's RLS `tenant_isolation` on `captured_documents` still hides the row. That is a second, independent layer (defence in depth), as in R-131's M7. |

## Browser proof (dev, Brightsphere, reporting-qa@isaflow.dev)
Dev server from this worktree on :3221. The session was minted for reporting-qa via GoTrue `generate_link` → `email_otp` → `/verify`.

**The pipeline has no button in the app.** Nothing under `pages/` or `src/components` calls it; only this route and the e2e smoke tests reference it. Each invoice was uploaded on `/accounting/capture` and extracted by the app's VLM. The route was then called from the signed-in page with `fetch` plus the `isaflow_csrf` header, as `apiFetch` sends it.

- `browser-bill-lines-journal-link.png`: VW-R160-2702, Venture Workspace, dated 2027-02-10 (Brightsphere's 2026 periods are closed). The route answered 200, `auto_approve`, no provisional. The page shows status approved, two lines ("Coffee service" 4 × R50, tax R30; "Meeting room - February" 1 × R850, tax R127.50), total R1 207.50, and "View GL Journal Entry".
- `browser-bill-journal.png`: JE-2027-00005, POSTED, source `auto_supplier_invoice`. DR 5100 Cost of Sales R200 + R850, DR 1140 VAT Input R157.50, CR 2110 Accounts Payable R1 207.50. Total debit = total credit = R1 207.50.
- `browser-closed-period-withdrawn.png`: VW-R160-0929, dated 2026-09-29 in a closed period. The route answered 200 with `settlementRefused: "Cannot post to closed fiscal period"`. The page shows status draft, its line "Hot desk - September" R640 + R96, and the note "Auto-approval withdrawn: its journal could not be posted (Cannot post to closed fiscal period). Review it and approve it by hand." There is no journal link. On master this bill would have sat `approved` with no journal.

Dev writes: two uploads and two pipeline runs through the app, as reporting-qa, in Brightsphere. That left one approved bill with its journal and one draft bill. No migrations.

## Historical data
`census.sql` is READ ONLY, for Hein to run on prod; it was never run there. Pipeline bills are distinguishable: they carry `posting_agent = 'ai:ai-invoice-pipeline:v1'`, and `capture/[id]/post` writes none.
1. Pipeline bills that are approved (or later) with no journal, per company, with counts of those without items and those with a zero total.
2. Pipeline bills (not cancelled) with zero items or a zero total.
3. The detail rows for query 1.

R-131/census.sql query 2 already counts these bills among captured approved bills with no journal. On dev (read-only) every query returns 0 rows. No repair is proposed.

## Not in scope (noticed)
- The pipeline never marks the document's `capture_events` row posted, which `capture/[id]/post` does. The document is claimed, so it cannot be posted twice, but the inbox event stays `extracted`.
- `recordCoding` still records `glAccountId: null` for pipeline bills.
