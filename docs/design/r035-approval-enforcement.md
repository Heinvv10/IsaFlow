# R-035 design: enforcing approvals on posting paths

Everything here was read from `origin/master` at `c82cb65d2`. I did not query any database.

## 0. Facts that change the plan

1. **The 234 seed rules are inert.** Migration 234 inserts them with no `company_id`. Migration 280 (`280_add_company_id_indexes.sql:20`) adds the column as nullable and never backfills it. The 251 demo seed also omits `company_id`. `checkApproval` filters on `company_id = ${companyId}` (`approvalMatching.ts:55`), so rows with a NULL company never match anything. Migration 665's own comment confirms NULL-company seeds exist.
   - New companies get no rules. The only writer of `approval_rules` is `createRule` (`approvalService.ts:166`).
   - So the overnight risk comes only from rules tenants created themselves through the UI or API. I can't see those without prod access, which is why the census in §3 is needed.
2. **`supplier_invoices.status` already allows `pending_approval`.** The CHECK in `201_accounts_payable.sql:36` permits it, and `documentPopulation.ts:55` keeps it out of the AP population. Nothing writes it today.
3. **Four supplier-invoice paths put a bill into the AP population (payable and ageable) without ever calling approve.** They are listed in §1 as B1–B4. Gating `approveSupplierInvoice` alone would leave all four open.
4. **Currency bypass.** `findDocument` matches rules against `total_amount` (`approvalDocuments.ts:58`), which is in the document's own currency. The ZAR figure is `functional_total` (`supplierInvoiceService.ts:100`). A USD 5,000 bill (about R92,500) would slip under a R50,000 rule. The fix is to match on `COALESCE(functional_total, total_amount)`.
5. **Journals can't be gated at `postJournalEntry`.** It has about 46 callers, almost all of them system journals (`source auto_*`). A rule like "All journal entries → accountant" would stop every invoice posting, depreciation run and bank allocation. Journal enforcement has to cover manual journals only.
6. **Existing defect in the route PR2 changes.** `supplier-invoices-action.ts:68-72` catches every error and returns 400. `withAuth` commits on 4xx, so a failure after the journal is written commits partial work. This is the same class `approveActionsNo4xxAfterWrite.test.ts` fixed for other routes. The new 409 must be mapped explicitly and everything else rethrown.

## 1. Inventory

### Supplier invoices: every path into posted or AP-population state

| # | Path | file:line | Who acts | Treatment |
|---|---|---|---|---|
| A1 | UI approve | `pages/api/accounting/supplier-invoices-action.ts:54` → `approveSupplierInvoice` | human | 409 |
| A2 | UI bulk approve | `supplier-invoices-bulk-action.ts:94` | human | per-row 409 message |
| A3 | UI bulk "Post to GL" | `supplier-invoices-bulk-action.ts:99` → `postSupplierInvoiceToGL` (`supplierInvoiceWorkflowService.ts:154`) | human | Already refuses drafts (R-118, `:201`). Only posts bills already in the population, so not gated (see Q7) |
| A4 | MCP `approve_supplier_invoice` | `src/lib/mcp/tools/writeSupplierInvoices.ts:162-178` | agent | Refused by a pre-read, which the tool's design requires (comment at `:157-161`) |
| A5 | MCP `bulk_approve_supplier_invoices` | `writeBulkApproveSupplierInvoices.ts:42` (APPROVABLE pre-read), `:108` (postOne) | agent | Skipped with reason `approval_required` |
| A6 | Recurring template with `autoPost` | `recurringTransactionInvoices.ts:184-193` → `approveSupplierInvoice`. Only caller is the `recurring-transactions-execute.ts:27` route; no cron | human-triggered run, unattended per bill | Leave the bill as draft, raise a request, return `posted:false` |
| B1 | Capture post | `pages/api/accounting/capture/[id]/post.ts:187-189` sets status, INSERT at `:220` | unattended (`auto_publish`/`auto_approve`) | **Inserts `'approved'` directly: no approve call, no journal, `approved_by` NULL.** Insert `'draft'` and raise a request |
| B2 | AI invoice pipeline | `pages/api/accounting/ai-invoice-pipeline.ts:196`, INSERT at `:184` | unattended | Same bypass; same fix as B1 |
| B3 | Sage import (staging) | `core/sageSupplierInvoiceImportService.ts:147`, route `sage-migration-action.ts:78` | import | Inserts `'approved'` directly. Exempt (Q1) |
| B4 | Sage migration commit | `admin/services/sageMigrationCommitService.ts:208` create, `:267` UPDATE to `'approved'` plus raw journal post | import | Exempt (Q1) |
| B5 | AP take-on CSV | `ap/migrationApService.ts:140` status, `:232` INSERT, route `migration/ap-invoices.ts:57` | import | Exempt (Q1) |
| B6 | Offline scripts | `scripts/import-sage-britech.ts:119`, `scripts/seed-historical-data.mjs:120`, `scripts/qa-seed/transactions.ts:70` | operator | Covered by the DB trigger |

Edit paths, which must invalidate an approval:
- `supplier-invoices-detail.ts:35-46`: header PUT (number, date, due date) on draft or `pending_approval`, taken without a lock.
- MCP `update_supplier_invoice` → `supplierInvoiceDraftUpdate.ts:70/179`: line edits, draft only. It deletes and re-inserts the item rows (`:215`).
- `gl/accountMergeDocumentRows.ts:70`: repoints `gl_account_id` on bill lines.
- The 3-way match (`supplierInvoiceWorkflowService.ts:428`) writes only match-state columns and should not affect the digest.

### Other document types: choke points and their callers
- **credit_note**: `approveCreditNote` (`ar/creditNoteApproveService.ts:35`). Callers: `credit-notes-action.ts:57`, `supplier-credit-notes.ts:110` (create-and-approve in one call) and `:147`, MCP `writeCreditNotes.ts:116`, `writeBulkApproveCreditNotes.ts:133`.
- **customer_invoice**: `approveCustomerInvoice` (`ar/customerInvoiceApprovalService.ts:83`) and `postCustomerInvoiceToGL` (`ar/customerPaymentAllocationService.ts:219`, via `customer-invoices-gl.ts:28`). Also recurring `mintRecurringCustomerInvoice`, MCP `finalize_invoice`/`bulk_finalize_invoices`, and Sage commit `sageMigrationCommitService.ts:187` (`historicalImport`).
- **payment**: `approveSupplierPayment`/`processSupplierPayment` (`ap/supplierPaymentWorkflowService.ts:35/82`), `processBatch` (`ap/batchPaymentService.ts:149`), `confirmCustomerPayment` (`ar/customerPaymentAllocationService.ts:44`). Unattended callers: `gatewayInvoiceReceiptService.ts:173` and MCP `writeSettleByContra.ts:237/262`. Payments created from bank lines record money that has already moved (Q4).
- **journal_entry** (manual sources only): `journal-entries-action.ts:65`, MCP `writeJournals.ts:149`, `recurringJournalService.ts:188`, `glImportExecuteService.ts:170`, `receipt-to-journal.ts:246`, `writeOpeningBalance.ts:172`. Provisional and bank-rule auto-posts (`capture/provisionalPostingService.ts:265`, `bank/autoPostGateService.ts:220`) are system journals.

## 2. Supplier-invoice design

**How "approved" is represented: derived, not stored.** Hein asked for a document-level approval status. I recommend it be a read-model field computed on the server, not a new column that writers set.
- A stored column would be a second writer set: nine insert sites, three edit paths, and a decide path that would have to write into five different document tables. Each of those is a way for the column to drift.
- The derived answer is: an `approved` request exists for this document whose `document_digest` equals the document's current digest and whose `required_role` rank is at least that of the strictest rule matching today.
- The detail GET returns `approval: { state: 'not_required'|'required'|'pending'|'approved'|'stale', requiredRole, requestId, ruleName }`.
- The bill stays `draft` while it waits. `pending_approval` is left unwritten (Q3).
- Why this is safer given 665 and 669: approved requests are terminal and `decideRequest` only updates pending rows. So the gate reads immutable rows plus a digest recomputed live. Nothing can be flipped to "approved" except through `assertMayDecide`.
- **Strongest argument against:** filtering the bill list by "awaiting approval" needs an EXISTS on `approval_requests`. That's cheap, because `uq_approval_requests_pending` covers the lookup.

**Binding the approval to what was approved: the digest.** One SQL function, `approval_document_digest(company uuid, doc_type text, doc_id uuid)`, created in the migration. Both `findDocument` and the trigger call it, so it has a single definition.
- For supplier invoices it is an md5 over `supplier_id, invoice_date, currency_code, exchange_rate, subtotal, tax_amount, total_amount, functional_total` plus a **content-sorted** `string_agg` of each line's `gl_account_id, quantity, unit_price, tax_rate, tax_amount, line_total`, and any other column `supplierInvoiceExpenseLines.ts` reads.
- Line ids are deliberately excluded because the draft edit re-inserts every row.
- Any header or line edit, and an account merge, therefore makes the approval stale. Reverting to identical content makes it valid again (Q9).
- Old approved requests have a NULL digest and never clear anything, which is the intended fail-closed behaviour.

**The choke point:** a new `src/modules/accounting/services/gl/approvalGate.ts`, generic across the five types.
- `evaluateApprovalGate(companyId, type, id)` returns `null` or a refusal, and reads only. MCP pre-reads and the bulk runner classification use it.
- `assertApprovalCleared(...)` throws `ApprovalRequiredError { reason: 'APPROVAL_REQUIRED'|'APPROVAL_PENDING'|'APPROVAL_STALE', requiredRole, requestId }`.
- Steps:
  1. Is there an `approval_enforcement` row for this company and type? If not, return.
  2. Call `resolveApprovalDocument`, which now returns amount (using the functional total) and digest.
  3. Call `checkApproval`. If no rule matches, return.
  4. Look up approved requests for the document with a matching digest, scoped to `company_id`, and compare rank with `requiredRank` in TypeScript.
- Placement: in `approveSupplierInvoice` directly after the status check at `supplierInvoiceWorkflowService.ts:60`. That is after the row lock at `:53` and **before** the journal-reuse branch at `:84` and before any write, so the 409 is a pre-write refusal.

**Backstop: a DB trigger** on `supplier_invoices`, BEFORE INSERT OR UPDATE OF status.
- It fires when the status enters the population, i.e. an INSERT, or an UPDATE from draft or `pending_approval`.
- It raises when enforcement is on, an active rule matches, and no approved request with the current digest exists.
- Only `migrationApService`, the Sage import and the Sage commit may bypass it, by setting `set_config('isaflow.approval_gate_exempt','import',true)`. A census test pins exactly those setters.
- **Why add it:** the B-paths are raw INSERTs, and a census of code misses scripts and future writers. The repo's lesson "Table must refuse forged rows" points the same way.
- **Cost:** the trigger checks existence only; the rank ratchet lives in the TypeScript gate. Two layers, with the trigger acting as a fail-closed floor that surfaces as a 500 and a rollback.

**Unattended paths (B1, B2, A6).** Before the INSERT, evaluate the rules against the amount. If approval is required, insert `'draft'`, write the items, then call `requestApproval` with `requested_by` set to the uploader or runner. The response carries `approvalRequest`. They should not refuse outright: the captured document is already claimed, and a refusal would strand it.

**How requests get raised.** Reuse the existing `POST /api/accounting/approval-requests {action:'request'}`; no new route.
- `rebindPendingRequest` (`approvalDocuments.ts:143-146`) must add the digest to its "unchanged" check and refresh it. A pending request has no approval yet, so refreshing its digest is safe.
- `decideRequest` must refuse `approve` with a 409 `DOCUMENT_CHANGED` when the request's digest no longer matches the current one. Otherwise the approver would be approving a figure the bill no longer has.
- The migration adds `approval_requests.document_digest`, written by the INSERT at `approvalDocuments.ts:205`.

**The 409 body:** `"Supplier invoice INV-123 needs <role> approval before it can be posted (rule: <name>)."`, with a variant for pending ("awaiting approval by a <role>") and for stale ("the invoice changed after it was approved; submit it again"). `details: { reason, requiredRole, requestId }`.

**UI changes** (`useSupplierInvoiceActions.ts:41-105`, `[invoiceId].tsx`):
- Detail page: states `required` and `stale` show **Submit for approval** instead of "Approve & Post GL". `pending` shows a badge naming the required role, plus **Withdraw** for the requester (self-reject is allowed, per K-043 round 7). `approved` shows the approve button.
- The approve handler must still handle a 409 from a race: check `res.ok` (apiFetch resolves on 4xx) and show the message plus the Submit button.
- Bulk results show the per-row reason.
- `pages/accounting/approvals/index.tsx` needs a document link and must surface `DOCUMENT_CHANGED`.
- The rules page gets a per-type **Enforce** switch with a "would block N bills" preview.

## 3. Rollout

**Recommendation: opt-in per company and per document type, default off.**
- New table `approval_enforcement(company_id, document_type, enabled_at, enabled_by, PK(company_id, document_type))`, with RLS. I haven't checked whether the 498 drift test requires RLS on new `company_id` tables; assume it does.
- The server holds a constant `ENFORCEABLE_DOCUMENT_TYPES` that grows by one type per PR. The API refuses to enable a type that isn't in it.
- That makes each PR's ship inert. A company that opted into supplier invoices isn't silently enrolled in journals when that PR lands, which a single per-company flag would do.
- **Turning enforcement off weakens a control.** It needs rank at least equal to the strictest active rule of that type, the same ladder as `assertMayEditRule`, and writes an audit row through `logAuditOrThrow`. Without that it reproduces the round-3 bypass: an admin switches enforcement off to clear their own bill.
- **Refuse to enable** when no user other than the most likely requester holds rank at least equal to the rule's approver role. Under K-043's self-approval ban, a sole-owner company would otherwise be unable to post at all.
- Enabling also needs Hein's go-ahead on sole-user tenants (Q2).

**Census for Hein to run read-only on prod before PR2 is enabled anywhere:**
```sql
-- 1. Active rules per company, and how many users could approve each
SELECT c.name, r.company_id, r.document_type, r.name, r.condition_operator, r.condition_value,
       r.approver_role, r.created_at,
       (SELECT count(*) FROM company_users cu WHERE cu.company_id = r.company_id
          AND (CASE cu.role WHEN 'super_admin' THEN 8 WHEN 'owner' THEN 7 WHEN 'system' THEN 6 WHEN 'admin' THEN 5
               WHEN 'manager' THEN 4 WHEN 'accountant' THEN 3 WHEN 'bookkeeper' THEN 2 WHEN 'viewer' THEN 0 ELSE 1 END)
           >= (CASE r.approver_role WHEN 'super_admin' THEN 8 WHEN 'owner' THEN 7 WHEN 'system' THEN 6 WHEN 'admin' THEN 5
               WHEN 'manager' THEN 4 WHEN 'accountant' THEN 3 WHEN 'bookkeeper' THEN 2 WHEN 'viewer' THEN 0 ELSE 5 END)) AS eligible_approvers
FROM approval_rules r LEFT JOIN companies c ON c.id = r.company_id
WHERE r.is_active ORDER BY c.name NULLS FIRST, r.document_type;
-- 2. Supplier bills from the last 90 days that a rule would have blocked
SELECT si.company_id, count(DISTINCT si.id) FROM supplier_invoices si
JOIN approval_rules r ON r.company_id = si.company_id AND r.is_active AND r.document_type = 'supplier_invoice'
WHERE si.created_at > now() - interval '90 days' AND si.status <> 'cancelled'
  AND (r.condition_operator = 'any'
       OR (r.condition_operator = 'greater_than'  AND COALESCE(si.functional_total, si.total_amount) >  r.condition_value)
       OR (r.condition_operator = 'greater_equal' AND COALESCE(si.functional_total, si.total_amount) >= r.condition_value))
GROUP BY 1;
-- 3. Existing requests (none of them carry a digest, so none will clear anything)
SELECT company_id, document_type, status, count(*) FROM approval_requests GROUP BY 1,2,3;
```

## 4. PR plan (in order)

**PR1: shared infrastructure, no behaviour change** (`ENFORCEABLE = []`)
- Migration `708_` (re-check the prefix at PR time; the prefix-race gotcha applies): the `document_digest` column, the `approval_enforcement` table with RLS, and the `approval_document_digest()` function for supplier invoices.
- `approvalGate.ts`.
- `findDocument`: switch to the functional total and add the digest.
- Rebind and decide digest checks; enable/disable API with the authority guard and audit.
- Tests: digest changes for each hashed column and not for match-state columns or line-id churn (mutate each column and watch it go red); stale decide → 409; disabling above one's rank → 403 plus an audit row; functional-total matching.

**PR2: supplier invoices.** Add the type to ENFORCEABLE, add the SI trigger, wire A1–A6 and B1–B5, narrow the catch-all at `supplier-invoices-action.ts:68`, and ship the UI. Real-PG integration tests through the real routes:
1. Enforcement on, rule matches, no request → approve returns 409; status stays draft; `gl_journal_entry_id` is NULL; no `auto_supplier_invoice` journal, draft or posted.
2. Request raised by A, approved by B, posted by A → 200 with the journal.
3. Approve, then edit the date through the detail PUT → 409 STALE. Edit lines through MCP → 409. Revert to identical content → 200.
4. Owner rule added after a manager approval → 409 (the rank ratchet).
5. Enforcement off → posts as today.
6. Tenant isolation: a forged approved row in company B carrying A's document id, inserted as `app_user`, does not clear A's bill; B's enforcement row does not enforce on A.
7. NULL-digest approved row → does not clear.
8. Bypass attempts:
   - bulk approve: the gated row fails, siblings commit;
   - MCP approve: `toolError`, no journal, idempotency key unused;
   - MCP bulk: skipped;
   - capture and AI pipeline: bill created as draft with a pending request, absent from the AP ageing;
   - recurring: draft plus request, `posted:false`;
   - raw `UPDATE status='approved'` or INSERT `'approved'` as `app_user` → trigger raises;
   - Sage import with the exemption → succeeds.
9. K-043 self-approval regression.
10. USD bill above the threshold in ZAR → gated.

Mutation checks. Each one must turn a test red:
- remove the gate call (test 1 expects 409 and would now see the trigger's 500);
- make the digest comparison always true (test 3);
- drop the rank comparison (test 4);
- drop `company_id` from the approved-request lookup (test 6);
- drop the enforcement lookup (test 5);
- drop the trigger (raw-SQL test);
- revert to `total_amount` (test 10);
- remove the capture downgrade (capture test).

**PR3 credit notes → PR4 customer invoices → PR5 payments → PR6 manual journals.** Each uses the same test template, the choke points in §1, and its own digest branch. PR5 and PR6 depend on the answers to Q4 and Q5.

## 5. Questions only Hein can answer

1. **Are imports exempt** (Sage sync, Sage commit, AP take-on)? Recommended: yes. Those documents were approved in the source system, and the exemption is a declared GUC pinned by the census test.
2. **Sole-user or sole-top-rank companies.** Under the self-approval ban they can never post a bill a rule matches. Recommended: refuse to enable enforcement until a second eligible approver exists.
3. **Stored `pending_approval` status or a derived state?** Recommended: derived. No new writer and no sync bugs.
4. **Payments that come from bank-feed allocations.** Recommended: exempt, since the money has already moved. Gate only payment instructions (approve/process and batch EFT).
5. **Journal enforcement on manual sources only?** Recommended: yes. System journals follow from documents that are already gated.
6. **Should MCP agents be able to submit for approval?** Recommended: not in PR2. Refuse or skip only, and never let MCP decide an approval.
7. **Bulk "Post to GL" for legacy bills that are approved but have no journal:** leave it ungated? Recommended: yes. After PR2 the gate sits where a bill enters the population, and the census shows the legacy count.
8. **Should new companies get default rules?** Recommended: no.
9. **Should reverting a bill to identical content make its approval valid again?** Recommended: yes.
10. **Should an account merge invalidate approvals on unposted bills?** Recommended: yes, since it fails closed; the requester submits again.

## Not verified
- Prod data: whether anyone backfilled `company_id` on the seed rules, and which rules or requests actually exist.
- Which route the UI "Save" on a bill uses. I assumed the detail PUT.
- Whether the RLS drift test (498) forces a policy on the new table.
- The exact line columns `buildExpenseLines` reads. They are what the digest must cover.

---
## HEIN'S DECISIONS (2026-09-26) — binding for implementation
- Rollout: opt-in per company AND per document type, default OFF (`approval_enforcement` table). Turning OFF is a weakening act: needs rank >= the strictest active rule of that type, and is audited.
- Q1 Imports (Sage sync, Sage migration commit, AP take-on): EXEMPT via the declared GUC `isaflow.approval_gate_exempt`, set only by those importers; a census test pins the setters.
- Q2 Sole approver: ALLOW SELF-APPROVAL for sole approvers (overrides the planner's recommendation). Definition: at DECIDE time, if no OTHER active member of the company holds rank >= the request's effective required role, the requester may approve their own request. It must be audited with a distinct marker (e.g. decision recorded as sole-approver self-approval) and must still pass every other check (rank, digest). Enabling enforcement is therefore NOT refused for sole-approver companies.
- Q3 Approval state: DERIVED (digest-matched approved request), no stored pending_approval writes.
- Q4 Payments (later PR): gate payment INSTRUCTIONS only; exempt payments recorded from bank-feed allocations.
- Q5 Journals (later PR): MANUAL sources only.
- Q6 MCP: may not submit or decide approvals in these PRs; refuse/skip only.
- Q7 Legacy approved-but-unposted bulk "Post to GL": ungated.
- Q8 No default rules for new companies.
- Q9 Reverting to identical content makes an approval valid again (digest match).
- Q10 An account merge invalidates approvals on unposted documents (fail closed).

---
## Decisions 2026-10-06 (Hein)

1. **Credit notes are two types:** `customer_credit_note` and `supplier_credit_note`, each with its own rules and switch. Both pass through `approveCreditNote`; the type follows `credit_notes.type`.
2. **Manual journals gate the human-composed paths:**
   - UI manual journal post (`journal-entries-action.ts`);
   - MCP `post_journal` (`writeJournals.ts`);
   - receipt-to-journal (`receipt-to-journal.ts`);
   - GL import with post-immediately (`glImportExecuteService.ts`);
   - reclassification batches (`reclassification/post.ts`);
   - recurring journal templates (`recurringJournalService.ts`, and recurring-transaction autoPost when it produces a journal). These are unattended, so they leave a draft and raise a request.

   Exempt: opening balances (`writeOpeningBalance.ts`, an import under Q1), close-run accruals, and every system journal that follows from an already-gated document (bank auto-post sweep, Paystack receipts, document postings, depreciation, payroll, VAT).
3. **A batch EFT is one approvable document** (`payment_batch`). Its digest covers every line: payee, bank details, amount. Changing any line voids the approval, and one request covers the batch.
4. **Merging is delegated:** the run merges each PR itself before starting the next, but only when every GitHub check passes on the exact head, the blind and adversarial reviewers both SHIP on that head, and the merge uses `--match-head-commit <full sha>`. **No deploys.**

---
## As built: customer invoices (PR4, migration 865)

- **Gate:** `approveCustomerInvoice` locks the invoice (`FOR UPDATE`) and calls `assertApprovalCleared` before its guarded status UPDATE, so a refusal writes nothing. Detail approve answers 409; MCP `finalize_invoice` refuses from a pre-read and `bulk_finalize_invoices` skips with `approval_required`.
- **Amount:** `approval_customer_invoice_gate_amount(total, functional)`, the larger of the two in absolute terms. The approval posts `total_amount` unconverted, as 712 found for bills. It replaces the functional-total-first match described in §0.4 for customer invoices, and only ever widens what a rule sees.
- **Backstop:** `trg_customer_invoice_approval_gate` refuses any entry into the AR population without a cleared approval at rank. On a DRAFT invoice under enforcement that includes:
  - a receipt confirm: the savepoint rolls it back, and `customer-payments-action` answers 409;
  - a whole write-off: 500 and rollback.

  Paystack receipts never reach it for a draft; they are banked unapplied. It honours the import GUC (Q1). A raw-SQL session can set that GUC itself (the N3 class, in the SECURITY DEFINER follow-up).
- **Lock:** the gate reads under `FOR NO KEY UPDATE`, taken only on an approvable invoice. Content edits wait for it, inserts that reference the invoice do not.
- **Upstream authors (Hein, 2026-10-06: whoever sets the price upstream is an author):** an invoice minted from a recurring template, a quote, a sales order or logged time carries the source's authors, who may not approve it.
  - A quote's or order's creator and every editor whose change moved what it billed count as authors. So does every user who changed a time entry's rate or billable flag.
  - Time entries (decision 1, round 3):
    - The rate sets the price.
    - A practice entry's logger does not count, because the rate comes from the rate tables. The tables are configuration, so whoever sets them is not an author either; this is a known limit.
    - A time-tracking logger types the rate, so they do count.
    - Changing someone else's hours counts. Your own hours are effort.
  - Source editors are stamped on the edit itself. The only stamp at creation is a time-tracking logger who types a rate.
  - A converted quote is terminal, so the link authors are derived through cannot be moved.
  - Accepted dead end: if every member of the rank authored or raised the invoice (two owners, one priced the quote and the other converted it), nobody may approve it. The refusal tells them to have the source's author (including whoever set a billed time entry's rate or hours) perform the conversion, run or invoicing themselves.
  - Template authors are written into the invoice at mint, because the invoice keeps no link to its template.
  - Conversion authors are derived by `approval_document_authors` from the links the converters already write. Supplier invoices minted from templates are not stamped; this is a known limit, because stamping them would change live enforcement.
- **Unattended (recurring invoices, recurring-transaction autoPost):** the invoice stays a draft, the request is raised as the runner, and the schedule advances. The run reports `held_for_approval`.
- **Imports (Q1):** the AR take-on, the Sage customer import and the Sage migration commit are exempt by rank against the strictest customer-invoice rule.
- **Q7:** the legacy "Post to GL" stays ungated.

---
## As built: supplier payments and batch EFT (PR5, migration 867)

- **Two types (Q4: payments gate the instruction to pay, never money already moved):**
  - `supplier_payment` is a single payment (`batch_id` NULL).
  - `payment_batch` is one approvable document. Its lines are its member payments and their allocations, and one request covers the whole batch.
  - A member is approved and paid only through its batch. The single-payment approve on a member is gated as the batch, and a member is not found as a `supplier_payment`.
  - The legacy `payment` type governs neither. New `payment` rules are refused, and both switches warn while active ones remain.
- **Gate points:** approve and process of each type. Each runs under the row lock and before any write:
  - `approveSupplierPayment` now locks and moves only a draft.
  - `approveBatch` now locks, requires a draft (409), refuses a zero-row update and records who approved on the members.
  - Process re-checks because the money moves there. An approval taken before enforcement, or content that moved since, is not paid.
- **Digest:**
  - A payment hashes its payee, date, amount, method, paying account, reference, dimensions and allocations.
  - It also hashes the payee's bank details, read LIVE from `suppliers`. They are not copied onto the payment, and the bank-file routes read them at send time.
  - A batch hashes its header (date, method, paying account, stored total) and every member line the same way.
  - So a supplier bank-detail edit stales every unpaid approved payment and batch to that supplier (fail closed).
- **Amount:**
  - A payment uses `ABS(total)`.
  - A batch uses the larger of its stored total, which its single journal posts, and its members' sum.
- **Authors (Hein, 2026-10-06: whoever sets the amount or the destination of the money):**
  - The creator.
  - The authors of every bill paid, derived in SQL through `payment_allocations`.
  - Whoever merged the supplier: both merges stamp.
  - Whoever changed the payee's bank details while the payment was unpaid: `updateSupplier` and the take-on overwrite stamp.
  - Whoever set the payee's CURRENT bank details (below).
  - A batch adds every member's authors.
  - Creating a payment stamps nothing, so golden path d writes no 867 column.
  - The refusal names the payment or batch, never a bill. Its way out: the bills' author creates the payment themselves.
- **Backstops:**
  - `trg_supplier_payment_approval_gate` fires on entering approved, processed or reconciled, and on approved → processed. A member checks its batch.
  - Exempt: an INSERT of a single payment under the `bank_feed` GUC (the four bank-feed creators, census-pinned) or the `import` GUC.
  - `trg_payment_batch_approval_gate` has no exemption.
  - Both use 862's rank ratchet.
- **Callers:**
  - Both action routes answer 409.
  - MCP `settle_by_contra` refuses a governed payable up front (Q6), because it creates and pays in one call.
  - Under `payment_batch` enforcement, `eft-generate` and `netcash/submit` answer 409 for an uncleared batch. Netcash also refuses a raw `payments[]` list (403) under either type's enforcement.
  - Out of scope, pinned: customer receipts and Paystack (money in), the bank-feed creators, and void, cancel and reverse.
- **Bank-details setter (decision (b), 2026-10-06):** `suppliers.bank_details_setters` records every user who changed a bank column since the account number last changed (append-only; a branch-code change appends, round 2), and whoever created the supplier with bank details. It is derived live into the authors of every payment and batch to that supplier, so whoever points the account somewhere before a colleague creates the payment may not approve it. A supplier write that changes no bank column never touches the column.
  - Known limit: a new account number makes that editor the only setter. Payments that were in flight keep the earlier setter, stamped. (Round 1 replaced the last-setter-only rule.)

### Round 1 (PR #658), Hein's decisions 2026-10-06
- **D1, coupled switches:** a single payment and a one-line batch pay the same bill.
  - Enabling or disabling either type moves both.
  - A batch needs approval at the strictest of its own rule and every member payment's `supplier_payment` rule.
- **D2, bank evidence only:** the bank-feed exemption covers only lines from a live bank feed or an imported statement.
  - A hand-keyed "Spend Money" line to a supplier goes through approval: 409 before any write, or skipped by the rule sweep.
  - A refund is money in and is not gated.
- **Bank-details setters are append-only.** Each change to a bank column adds its editor. Only a change to the account number resets the list to that editor; a branch-code change appends (round 2, so an innocent universal-code "fix" cannot drop whoever redirected the number).
- **Statement-level member check:** batch members are checked once per batch per statement.


---
## As built: manual journals (PR6, migration 869)

- **What is gated (decision 2, the human-composed paths only):** `postJournalEntry` stays ungated — it carries every system posting and re-enters itself for a late claim. Each human-composed entry point calls `gl/manualJournalApproval.ts`, and a census (`manualJournalApprovalCensus.test.ts`) classifies every caller of `postJournalEntry` as gated or exempt, with the reason; a new caller fails until it is classified.
  - **UI post** (`journal-entries-action`) and **MCP `post_journal`**: gate ANY draft a person (or agent) posts, whatever created it, under the journal's row lock and before any write — 409, or a tool error that leaves the idempotency key free (Q6). `create_draft_journal` stays ungated.
  - **Receipt autoPost, GL import with post-immediately, the recurring journal run and recurring-transaction journal autoPost** are unattended: each decides from the amount before writing, leaves a gated journal a draft and raises the request as the person who ran it, and never refuses after a write. The receipt claim stands (the document cannot be posted twice); the import never fails because of approval and lists the held ids; the schedules advance.
  - **MCP reclassification** creates and posts in one call with no draft surviving: refused up front when any journal it would post matches a rule (the dry run gives the same refusal).
- **Not gated:** opening balances (they write source `manual`, so nothing keys on `source`), every system or document posting, the reversal of a posted journal and `bank-transfers.ts` (a raw `'posted'` insert) — the last two are not in decision 2 and are follow-ups for Hein. **Close-run** is gated (Hein, 2026-10-07, decision (b)): its `post_draft_journal` proposal posts ANY balanced draft by id when a person approves it — the UI Post by another door — so the approve gates it under the lock before the claim (409 with the reason, nothing written, the proposal stays retryable). Close-run creates no journals of its own.
- **Digest:** the header a person types (date, description, reference, project, cost centre, intercompany flag and counterparty) and every line (account, debit, credit, narrative, VAT code, the five dimensions), lines ordered by created_at then content then id; bookkeeping, numbers, timestamps, actor stamps and evidence flags excluded. **Amount:** the larger side of the lines, in absolute terms.
- **Authors:** the creator (composer, importer, uploader, runner) plus, while enforced, the recurring template's creator and editors (stamped into the journal at mint; the recurring-journals PUT stamps the template's editors) and whoever merged an account a draft's lines named. The account merge is the one path that edits a draft's content: it stales the approval (Q10).
- **Backstop:** a marker, `gl_journal_entries.approval_document_type = 'manual_journal'`, written by the gated paths ONLY while enforcement is on (golden path g writes no 869 column). A marked journal may not enter 'posted' without a cleared approval (862's ratchet), may not be inserted already posted under enforcement, and its marker never clears. Known limit: raw SQL that posts an UNMARKED journal is not caught; the TypeScript gates are the control.
- **Late claim:** for a MARKED journal under enforcement the s16(3) split posts the original before rewriting its VAT lines, so the backstop judges the content the approver approved. Every other journal — and every journal while enforcement is off — keeps master's order (rewrite, then post).

### Round 3 (PR #660), Hein's scope decisions 2026-10-07
- **H1, recon adjustment:** a person names its contra and amount, so it is a manual journal: refused 409 before the journal is created under a matching rule, telling them to post it as a journal through approval.
- **H2, hand-keyed bank lines to a GL account:** Spend/Receive Money to an account, and allocating or splitting an existing hand-keyed line to accounts (screens, MCP allocate and bulk allocate — skipped there, dry run alike), are refused 409 before any write under a matching rule. Lines from a live feed or an imported statement stay exempt (PR5's D2). `bank-transactions-import-classified` sets `import_batch_id` from the body; broken on master, counted as an import, left.
- **Petty-cash capture post-expense** holds a gated slip as a draft with a request raised by the uploader, like receipt-to-journal.
- **MCP `set_opening_balance`** is refused outright under enforcement (round 4, Hein — superseding round 3's contra-only rule: an agent could relabel any asset 'bank' and post it against Opening Balance Equity): a person enters opening balances. The admin UI opening-balance route stays exempt.
- **Authors** (template creator and editors, the account merger, a journal template's rename) are recorded whether or not enforcement is on. **Person- and agent-composed drafts** are marked at create under enforcement. **The unattended hold** decides on each line's stored cents, summed exactly, as the backstop does.
- Not changed, for Hein: the recurring-journals PUT writes 869 columns unconditionally (as 865/867 did; dev needs the migrations); prefix 868 is left as headroom.

### Round 4 (PR #660), 2026-10-07
- **The bank-rule sweep** (`bankRuleAutoPostLine`): an account rule posting a HAND-KEYED line is skipped as `approval_required` (counted) under a matching manual-journal rule, before any write — PR5's supplier arm's twin — whatever ran the sweep (rules applied, a statement import, a reversed allocation back in 'imported').
- **Hand-keyed transfers** to another bank-subtype account are manual journals too (any account can be relabelled bank): Spend/Receive Money and allocate refuse them 409 before any write. The MCP tools expose no transfer; the sweep has no transfer rule (an account rule to a bank account is the account arm).
- **MCP `set_opening_balance`** is refused outright under enforcement (above).
- **Authorship recorded regardless of enforcement** means the recurring runs and the account merge write 869 columns on any company: dev needs the migration (Hein's call).

### Round 5 (PR #660), 2026-10-07
- **Provisional posting** (`postProvisional`, from the provisional/outstanding route and the auto-post gate's import branch) posts DR <predicted account> / CR bank for an unallocated outflow: a HAND-KEYED one is a manual journal, so under a matching rule it is skipped as `approval_required` before any write, and both callers report it (adversarial REPRO 4).
- **VAT guard:** calling the moved `vatInclusiveSplit` is its own guard kind, allowlisted only for `bankVatInclusive.ts` and `bankAllocationService.ts`; the latter no longer excuses a rate constant it no longer has.

---
## As built: N1 — approval requests written only through SECURITY DEFINER functions (migration 872)

- **The hole closed (for any session that stays app_user or platform_admin — see the last bullet for one that does not):** a statement as `app_user` (or `platform_admin`, BYPASSRLS) could `UPDATE approval_requests SET status = 'approved'`, INSERT a decided row (supplier_invoice was outside 862's guard), DELETE a request, or rewrite `required_role` / `rule_id` / `decided_by` — and every gate trusts an approved row.
- **Privileges:** every non-owner INSERT / UPDATE / DELETE / TRUNCATE / TRIGGER grant is revoked, table- and column-level, enumerated from the ACL (app_user, PUBLIC, platform_admin, migration_admin on the fixture; whatever else an environment granted). SELECT stays. The migration asserts it for every role by catalogue and, as app_user, by outcome (each write and a `FOR UPDATE` refused 42501). No src path wrote the table as platform_admin or migration_admin (import-graph census from `pages/api/admin` and `src/modules/admin`).
- **The writers (census by table: requestApproval's INSERT, rebindPendingRequest's UPDATE, decideRequest's UPDATE, the decide row lock — there is no cancel/withdraw write):** `approval_request_raise`, `_rebind`, `_decide`, `_lock`. SECURITY DEFINER, `search_path = pg_catalog, public, pg_temp`, every relation schema-qualified, owner asserted to bypass RLS, EXECUTE for app_user only (helpers for nobody). Each re-checks, with the same SQL definitions the TypeScript reads:
  - the session: decide refuses `impersonation` and `unknown` (`assertDecidingSession`), raise and rebind refuse `impersonation` (`assertNotImpersonating`) — the impersonation refusal IS representable in SQL (claims `session_id` + `impersonation_sessions`);
  - the actor: `auth.uid()` (as a uuid, any case) is the requester / decider named; the company is `app.current_company_id()`; the caller can see the company as RLS would (membership) — raise/rebind keep 862's exemption for a caller that bypasses RLS (scripts, fixtures);
  - the write role (review round 1): every route that raises, re-binds or decides — `approval-requests`, `capture/[id]/post`, `capture/[id]/post-expense`, `ai-invoice-pipeline`, `receipt-to-journal`, `gl-import`, `recurring-invoices-action`, `recurring-invoices-run`, `recurring-transactions-execute`, `recurring-journals-action` — is wrapped in `withWriteAccess` with the default roles, so the actor's company role must be owner, admin or manager (`approval_request_may_write`, bound to `writeRoles.ts` by `r035-n1-roles`); reject (a withdrawal) included; RA008;
  - raise: the document exists in the company (`findDocument`'s SQL twin `approval_request_document_facts`), the rule is the company's, active, of the type (a batch may bind a member's supplier_payment rule) and as strict as the strictest matching rule today; amount, reference, digest, `content_authors` and the Q2 roster are computed in SQL, never taken from the caller;
  - rebind: the row under FOR UPDATE, pending; a rule only upwards from `COALESCE(required_role, bound rule's role, 'admin')`; "content moved" decided from the digest it computes;
  - decide: the row under FOR UPDATE, this company's, pending; the ratchet (higher of `required_role` and the bound rule's live role); the author refusal (live ∪ snapshot authors, or past requesters for a type with no editor tracking); the requester refusal with Q2 exactly as `approvalSelfApproval.ts` (enforced, roster unchanged since the request, no OTHER active member at the demanded rank); a foreign rule; membership; rank; then the document exists and expected = stored = live digest.
- **TypeScript:** the four calls live in `gl/approvalRequestWrites.ts`; the existing checks, messages and error types are unchanged and run first. A SQL refusal (RA001–RA008) maps back onto the same error type, so routes answer the same status; RA009 (forged actor, company or rule type — the app never sends one) is a 500. RA010 — the rule the TypeScript chose is no longer the strictest (a rule added or edited, or the amount moved, in the window) — is refused with nothing written; `requestApproval` re-reads and raises once more, and a second race is a 409 with its own reason, `APPROVAL_RULES_CHANGED` (the client renders every 409 message generically, so a distinct reason lets a caller tell "submit again" from the decide path's `DOCUMENT_CHANGED`). The unattended raisers (capture post, AI pipeline, recurring runs, the journal holds) do not map it: they write the document before they raise, so a 4xx there would COMMIT a half-made run — a double race is a 500 that rolls the whole run back, and running it again raises cleanly. A rule deactivated in that window makes rebind keep its binding and still re-stamp the content, as the old UPDATE did.
- **The Q2 audit row** (`approve`, `approval_request`, metadata `selfApproval: 'sole_approver'`, `requiredRole`, `approverRoster`, `documentType`, `documentId`, `documentDigest`) is written by `approval_request_decide` itself, in the decision's transaction, so the decision cannot commit without it. It is only as durable as `audit_log`: app_user can still UPDATE or DELETE it (or INSERT a forged marker) by raw SQL — see "Not closed by N1". The TypeScript no longer writes it. `approverRoster` is the stored snapshot's JSON text (Postgres spacing; every reader parses it).
- **Catalogue:** `r035-n1-catalog.int.test.ts` reads the live database wherever DATABASE_URL is set — grants (role, PUBLIC, membership), DEFINER, `pg_temp` last, owner, EXECUTE, the writers' bodies and every function they call transitively (helpers, rank ladder, gate amounts, authors, roster, claims helpers, insert guard) pinned by `md5(prosrc)` with the set checked closed — except `approval_document_digest`, shape-checked only because other branches redefine it by design: a legitimate change (more columns) only stales approvals, but a weakened one (fewer columns, a constant) would widen them and passes the catalogue; its controls are review of each digest-redefining migration, their own "existing digests unchanged" guards, and the digest behaviour suites on the fixture (decide, parity, raise, approval-digest, pr3-digest — red on a constant digest in review round 5) — the triggers on `approval_requests` pinned to exactly the insert guard, and statically named writes in any other body. A writer that builds its SQL at run time is beyond it: for the four writers the body pin and the behaviour suites on the disposable fixture are the backstop; a new run-time-SQL writer is caught by no test (migration review is the control). Without 872 it fails saying so.
- **Census:** `approvalRequestWriteCensus.test.ts` walks src/pages/scripts/lib on disk (untracked files included): any statement writing, truncating or locking the table, a quoted table name, or a call of the writers outside `approvalRequestWrites.ts` fails; so does a later migration re-granting a write on the table or `ON ALL TABLES IN SCHEMA public` (348's statement would silently reopen N1).
- **Unchanged:** who may approve what, Q2, the ratchet, live supplier-invoice enforcement (every approval suite passes; the five that pinned app_user's direct INSERT were re-pointed — forgeries now refused by privilege, legitimate raises through `approval_request_raise`). The 862 insert guard stays; a definer INSERT passes through it unchecked (its owner bypasses RLS).
- **Not closed by N1:** raw SQL is not stopped — the app logs in as a superuser and drops to app_user with `SET LOCAL ROLE`, so injected SQL can `RESET ROLE`, and can `set_config` the claims GUC (N3). N1 binds application code paths. Three tables the decision trusts remain directly writable by app_user under RLS alone — follow-ups for Hein, outside N1:
  - `approval_enforcement` (switch enforcement off) and `approval_rules` (deactivate or weaken a rule);
  - `audit_log` (`app_user=arwd`, RLS company-scoped): the Q2 sole-approver row can be deleted or rewritten after the decision commits, and a forged `sole_approver` marker inserted — the row records a self-approval, it does not make one tamper-proof;
  - `company_users`, through the `cu_admin_write` policy: an admin can raise their own role to owner (or demote or remove other owners before raising, manufacturing a Q2 sole approver) by raw SQL, and the definers trust that role — the route refuses it (`company-users.ts`, pentest H5), the table does not.
  - Also outside N1: `auth.user_admin_companies(text)` is SECURITY DEFINER with `search_path = public` and no explicit `pg_temp`, so pg_temp is searched first (the 872 definers do not call it).

## As built: supplier bank-detail verification (forensic-controls step 1, migration 876)

Not an approval document type, but it shares the switchboard: `approval_enforcement.document_type = 'supplier_bank_details'`
(`EnforcementType` / `ENFORCEABLE_TYPES` in `gl/approvalRuleOptions.ts`; `RULE_FORM_DOCUMENT_TYPES` is unchanged — no rule
is ever written for it). Hein's decisions, 2026-10-08:

- **Gate outbound money only.** `eft-generate` and `netcash/submit` (batch mode) refuse 409 `SUPPLIER_BANK_DETAILS_UNVERIFIED`,
  naming the suppliers, when any payee is unverified; a raw Netcash `payments[]` list is refused 403 while the control is on.
  Nothing that records money is gated. Census: `tests/unit/services/ap/supplierBankVerificationCensus.test.ts`.
- **Independent of payment approval**: works with `supplier_payment`/`payment_batch` enforcement on or off.
- **Derived state**: verified iff the latest `supplier_bank_verifications` row's fingerprint equals
  `supplier_bank_fingerprint()` of the five current bank columns (trimmed, whitespace collapsed, lower-cased names;
  digits-only account and branch; '' = NULL). `supplier_bank_verified(company, supplier)`.
- **Switch-on baseline**: enabling writes a `baseline` row for every non-deleted supplier with bank details, by the
  switcher, in the enable's transaction (the 876 guard accepts a baseline only then) — except suppliers whose current
  details the switcher set (a refinement of decision 3: otherwise off → change → on verifies one's own change; the guard
  refuses such a baseline too). Enabling needs a human session and a
  role ≥ the verifier role; disabling needs `mayWeakenAtLevel` at the verifier role.
- **Who verifies**: role ≥ `supplierBankVerifierRole` (the strictest active `supplier_payment`/`payment_batch` rule's role,
  else `admin`); not in `bank_details_setters`, except R-035 Q2's sole approver (no OTHER active member reaches the role),
  recorded `self_verified` with `approval_roster_snapshot`. Cookie session only (impersonated / claim-less refused).
  Verify sends the fingerprint the verifier saw; the supplier is locked FOR UPDATE and a changed fingerprint is 409.
- **Table**: append-only (app_user SELECT+INSERT; a trigger refuses UPDATE/DELETE/TRUNCATE for every role except the FK
  cascade from a purged supplier); RLS binds tenant and `verified_by = auth.uid()`; a BEFORE INSERT guard binds the row
  to the supplier's current fingerprint, refuses a setter's plain `verified` and any verify while the control is off.
  Same boundary as N1: it binds code paths, not raw SQL run as app_user.
- **Not in this step**: a bank-detail edit UI, evidence uploads, employee/payroll beneficiaries, steps 2–5 of the programme.

