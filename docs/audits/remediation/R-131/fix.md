# R-131: capture/[id]/post creates supplier invoices with no line items

## What was found (reproduced on origin/master 3e4728e98, 2026-09-29)
On the disposable fixture (`isaflow-fixture-r131-goal`, cloned from r155 at migration 716), through the real `withAuth` route as app_user. A clean, low-value capture of R402.50 (R350 net + R52.50 VAT) with one extracted line posted:

```
route=200 approvalRoute=auto_approve
bill={"status":"approved","total":402.5,"gl_journal_entry_id":null,"items":0}
AP subledger=402.5 AP in GL=0
PostToGL: Invalid journal entry: Entry is not balanced: total debit R52.50 != total credit R402.50 (difference: R350.00)
```

The bill is owing in the AP subledger with no journal. "Post to GL" cannot book it: `buildExpenseLines` builds the expense side from the items, and there are none. A zero-total document was also accepted as a R0 bill.

## Root cause
`pages/api/accounting/capture/[id]/post.ts` INSERTed `supplier_invoices` directly and never wrote the `supplier_invoice_items` that `buildInvoiceFromExtraction` had already built. An auto-approved bill was inserted as `approved` and never posted unless it evidenced a bank-first provisional (the R-127 settlement path). R-127 then withdrew even those to draft, because the settlement's journal could not balance without lines.

## Decision (Hein, 2026-09-29)
- Extracted line items exist → use them.
- No extracted line items → ONE line from the extracted totals: net = total − VAT, tax = the extracted VAT. The account is chosen in this order:
  1. the capture event's `resolved_gl_account_id`
  2. the supplier coding rule's `default_gl_account_id`
  3. the company `default_expense` system account
- No total, or no account from any of the three → refuse with a 4xx. Never insert a bill with zero lines.
- The lines are inserted before `raiseUnattendedApproval`. The approved bill is posted through `postSupplierInvoiceToGL` in the capture follow-up, with R-127's revert to draft.
- `ai-invoice-pipeline` is reported as a sibling finding only.

## Fix
- `src/modules/accounting/services/capture/captureBillLines.ts` (new)
  - `planCaptureBillLines` is read-only. The route calls it after the gate decision and before `claimCapturedDocumentForPosting`, the last point where a 4xx commits nothing.
  - It returns the lines or a refusal:
    - total ≤ 0 → refused
    - an extracted line that `assertSupplierInvoiceLines` refuses → refused
    - no account from any of the three sources → refused (`MissingSystemAccountError` only; any other fault is thrown)
    - an account `billLineAccountRefusal` refuses → refused
  - Extracted lines go through `computeSupplierInvoiceTotals`, the rounding every bill uses. They carry the event's or the rule's account when there is one; otherwise they stay uncoded like every other bill's lines, and approval posts them to `default_expense`.
  - `insertCaptureBillLines` writes them on the request transaction, straight after the bill INSERT, with `createSupplierInvoice`'s column list.
- **Reuse vs direct insert.** `createSupplierInvoice` is not reused, for two reasons:
  - It recomputes `subtotal`/`tax_amount`/`total_amount` from the lines. The duplicate gate, the fingerprint and the approval route have already ruled on the document's own extracted totals, and an OCR'd line set does not always sum to them.
  - It cannot write the `status`, `source_document_id` or `duplicate_fingerprint` this route sets, and it opens its own transaction.
  - The shared pieces are reused instead: `assertSupplierInvoiceLines`, `computeSupplierInvoiceTotals`, `defaultVatClassification`, `billLineAccountRefusal`. Posting goes through the one journal path, `postSupplierInvoiceToGL` → `buildExpenseLines`, so lines, VAT and journal follow the same path as every other bill.
- **`pages/api/accounting/capture/[id]/post.ts`**
  - It plans the lines before the claim (answering 400 on a refusal).
  - It inserts them before `raiseUnattendedApproval`, because the approval request's digest (migration 708) binds the lines.
- **`captureRowLock.lockCaptureEventForPosting`** also returns `resolvedGlAccountId`.
- **`provisionalAttachSettle.attachEvidenceAndSettleApproved`**
  - New `postUnattached` input. Only `capturePostFollowUps` passes it.
  - An auto-approved bill that evidences no provisional is posted through `postSupplierInvoiceToGL`.
  - If that fails, the bill goes back to draft with "Auto-approval withdrawn: its journal could not be posted (…)" in its notes and in `settlementRefused`. Examples: a closed fiscal period, a filed VAT period, a missing `payable` account.
  - The response then says `draft` / `manual_review`.

## Gates that still hold
- `approvalUnattended`: `unattendedBillStatus` still decides draft + request under an enforced rule. The lines now precede the request, so a decided request lets the bill approve and post.
- `unattendedPostingGate`: `refusesUnattendedApproval` is unchanged.
- `captureEventLock` / `captureRowLock`: the event and document locks are unchanged. The only addition to the lock is one read column.

| Suite | Result |
|---|---|
| Integration, fixture, `--no-file-parallelism`: `k072-draft-claim-release`, `r058-capture-post-double-post`, `r107-auto-attach-savepoint`, `r088-receipt-content-dedupe`, `r035-pr2-unattended`, `r088-evidence-attach-race`, `k072-claim-vat-classification`, `r088-content-fence-routes`, `r-032-l5-approval-routes`, `k072-capture-vat-unread`, `k072-capture-posting-fence`, `r088-evidence-attach-check`, `r131-capture-post-lines`, all `r127-*` | 24 files, 201 tests passed |
| Unit: `capturePostFingerprint`, `tests/unit/services/capture/`, `k072-posting-fence-refusal`, `k076-unattended-posting-gate`, `k076-round*-policy`, `k076-larger-figure`, `k072-vlm-negative-total`, `mcp/bulkApproveTools`, `mcp/writeSupplierInvoicesTool` | 64 files, 2298 tests passed |

`vat-late-claim-callers.int.test.ts` refuses to run on a fixture (it asserts the database is isaflow_dev). It does not call this route.

Test changes needed by the fix:
- `r127-capture-auto-approve`: two route tests made the settlement fail only because the bill had no lines. They now file the month's VAT period instead, so they still prove the refusal branch and the ≥500 revert-failure branch.
- `k072-capture-posting-fence`: the fixture company had no `payable` account, so its auto-approved bill now could not post and was withdrawn. The fixture gains one.
- `capturePostFingerprint` (unit, fully mocked): mocks the new `captureBillLines` module.

## Tests (real PG, through the route, app_user with withAuth GUCs)
`tests/integration/r131-capture-post-lines.int.test.ts`. On master 7 of 8 fail; the tenant case passes on master.

| Test | Proves |
|---|---|
| extracted line items become the bill's items, and the auto-approved bill posts balanced | items match; journal DR 350 expense + 52.50 VAT = CR 402.50 AP; AP subledger = GL |
| no extracted lines, no rule, no event account: ONE line on the company default_expense, balanced | one item on `default_expense`; balanced; AP subledger = GL |
| no extracted lines: ONE line on the supplier coding rule's default account, balanced | the rule's account |
| no extracted lines: the capture event's own account comes before the rule's | event account first |
| no extracted lines and no account anywhere: 4xx, and nothing is inserted or claimed | 400 in a tenant with no `default_expense`; no bill, document unclaimed, event unchanged |
| an auto-approved bill whose journal cannot post goes back to draft, off AP, and says so | filed VAT period → draft, no journal, note, response `draft` |
| no total: 4xx, and nothing is inserted or claimed | 400; nothing written |
| another company's capture is refused, and nothing is inserted | 404; nothing written |

Also `tests/integration/r035-pr2-unattended.int.test.ts` › "capture/[id]/post: the request it raises, once approved, lets the bill approve and post".

## Mutation table
Each mutation was applied to a backup copy, the named test was run, and the file was restored from the backup (`cmp` checked).

| # | Guard removed | Named test | Red on |
|---|---|---|---|
| M1 | `insertCaptureBillLines` call (route) | extracted line items become… | `expected [] to deeply equal [ …(2) ]` |
| M2 | total ≤ 0 refusal | no total: 4xx… | `expected 200 to be 400` |
| M4 | `postUnattached` (post only when a provisional is attached) | extracted line items become… | `the approved bill carries a journal: expected null not to be null` |
| M5 | lines inserted AFTER `raiseUnattendedApproval` | r035-pr2 › the request it raises, once approved… | `expected 409 to be 200` (stale digest) |
| M8 | one-line fallback left uncoded | …supplier coding rule's default account… | `toMatchObject` on `gl_account_id` |
| M9 | withdraw-to-draft result dropped | …journal cannot post goes back to draft… | `expected 'approved' to be 'draft'` |
| M10 | rule before event account | …event's own account comes before the rule's | `toMatchObject` on `gl_account_id` |
| M11 | `default_expense` fallback removed | …company default_expense, balanced | `expected 400 to be 200` |
| M12 | no-account refusal removed | …no account anywhere: 4xx… | `expected 200 to be 400` |
| M13 | `MissingSystemAccountError` → null removed | …no account anywhere: 4xx… | `expected 500 to be 400` |
| M14 | lock returns no `resolvedGlAccountId` | …event's own account comes before the rule's | `toMatchObject` on `gl_account_id` |
| M7 | both `company_id` filters in `lockCaptureEventForPosting` | another company's capture… | **stays green**: app_user's RLS `tenant_isolation` on `capture_events` / `captured_documents` still hides the row, so a third, independent layer refuses it (defence in depth, not a gap) |

## Browser proof (dev, Brightsphere, reporting-qa@isaflow.dev)
Dev server from this worktree on :3211. Each document was uploaded on `/accounting/capture`, extracted by the app, and posted from `/accounting/capture/inbox`.
- `browser-bill-lines-journal-link.png`: VW-R131-2701, dated 2027-01-15 (Brightsphere's 2026 periods are all closed on dev). Status approved, two lines ("Hot desk - January" R1 000, "Printing credits" 2 × R100), "View GL Journal Entry".
- `browser-bill-journal.png`: JE-2027-00003, `auto_supplier_invoice`. DR 5100 Cost of Sales R1 000 + R200, DR 1140 VAT Input R180, CR 2110 Accounts Payable R1 380. Total debit = total credit = R1 380.
- `browser-totals-only-one-line.png`: VW-R131-2703, totals only, no lines extracted. Approved, ONE line "As per invoice" 1 × R640, tax R96, on Brightsphere's `default_expense` (no rule, no event account).
- `browser-totals-only-journal.png`: JE-2027-00004. DR 5100 R640, DR 1140 R96, CR 2110 R736; balanced.
- `browser-closed-period-withdrawn.png`: VW-R131-0929, dated 2026-09-29 in a closed period. It has its two lines, status draft, and the note "Auto-approval withdrawn: its journal could not be posted (Cannot post to closed fiscal period)…". On master this bill would have sat `approved` with no journal.

Dev writes: four uploads and three posts through the app, as reporting-qa, in Brightsphere. One uploaded slip, VW-R131-2702, was left extracted and unposted in the inbox; the VLM read one line from its description. No migrations.

## Sibling finding (not fixed, per Hein)
`pages/api/accounting/ai-invoice-pipeline.ts` writes its line items. However, it still leaves an auto-approved bill that evidences no provisional as `approved` with no journal, the same AP-over-GL gap. The fix would be to pass `postUnattached: true` in its `attachEvidenceAndSettleApproved` call.

## Historical data
`census.sql` (READ ONLY, for Hein to run on prod; never run here):
1. approved/partially_paid/paid supplier invoices with zero items and no journal, per company;
2. captured approved bills with no journal, with or without items, per company;
3. the detail rows for query 1.

No repair is proposed. On dev, query 1 returns 6 groups, none from capture (the capture flow was unused there).
