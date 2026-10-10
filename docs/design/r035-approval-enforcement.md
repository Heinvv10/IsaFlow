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
- **Not gated:** opening balances (they write source `manual`, so nothing keys on `source`), every system or document posting, the reversal of a posted journal and `bank-transfers.ts` (a raw `'posted'` insert) — the last two are not in decision 2 and are follow-ups for Hein. **REVISED 2026-10-09 (forensic-controls step 2):** Banking > Transfers is a person-composed manual journal: refused up front since #670, and now held as a draft plus an approval request (step 2 E, below). **Close-run** is gated (Hein, 2026-10-07, decision (b)): its `post_draft_journal` proposal posts ANY balanced draft by id when a person approves it — the UI Post by another door — so the approve gates it under the lock before the claim (409 with the reason, nothing written, the proposal stays retryable). Close-run creates no journals of its own.
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
- **The Q2 audit row** (`approve`, `approval_request`, metadata `selfApproval: 'sole_approver'`, `requiredRole`, `approverRoster`, `documentType`, `documentId`, `documentDigest`) is written by `approval_request_decide` itself, in the decision's transaction, so the decision cannot commit without it. Since migration 880 (N1b A) no role but `audit_log`'s owner can UPDATE, DELETE or TRUNCATE it; a forged extra marker can still be INSERTed — see "As built: N1b". The TypeScript no longer writes it. `approverRoster` is the stored snapshot's JSON text (Postgres spacing; every reader parses it).
- **Catalogue:** `r035-n1-catalog.int.test.ts` reads the live database wherever DATABASE_URL is set — grants (role, PUBLIC, membership), DEFINER, `pg_temp` last, owner, EXECUTE, the writers' bodies and every function they call transitively (helpers, rank ladder, gate amounts, authors, roster, claims helpers, insert guard) pinned by `md5(prosrc)` with the set checked closed — except `approval_document_digest`, shape-checked only because other branches redefine it by design: a legitimate change (more columns) only stales approvals, but a weakened one (fewer columns, a constant) would widen them and passes the catalogue; its controls are review of each digest-redefining migration, their own "existing digests unchanged" guards, and the digest behaviour suites on the fixture (decide, parity, raise, approval-digest, pr3-digest — red on a constant digest in review round 5) — the triggers on `approval_requests` pinned to exactly the insert guard, and statically named writes in any other body. A writer that builds its SQL at run time is beyond it: for the four writers the body pin and the behaviour suites on the disposable fixture are the backstop; a new run-time-SQL writer is caught by no test (migration review is the control). Without 872 it fails saying so.
- **Census:** `approvalRequestWriteCensus.test.ts` walks src/pages/scripts/lib on disk (untracked files included): any statement writing, truncating or locking the table, a quoted table name, or a call of the writers outside `approvalRequestWrites.ts` fails; so does a later migration re-granting a write on the table or `ON ALL TABLES IN SCHEMA public` (348's statement would silently reopen N1).
- **Unchanged:** who may approve what, Q2, the ratchet, live supplier-invoice enforcement (every approval suite passes; the five that pinned app_user's direct INSERT were re-pointed — forgeries now refused by privilege, legitimate raises through `approval_request_raise`). The 862 insert guard stays; a definer INSERT passes through it unchecked (its owner bypasses RLS).
- **Not closed by N1:** raw SQL is not stopped — the app logs in as a superuser and drops to app_user with `SET LOCAL ROLE`, so injected SQL can `RESET ROLE`, and can `set_config` the claims GUC (N3). N1 binds application code paths. Four tables the decision trusts were left directly writable by app_user under RLS alone; N1b closes all four (below): `audit_log` (A), `approval_enforcement` and `approval_rules` (B), and `company_users` with the invitations that feed it (C — an admin could raise their own role to owner by raw SQL through `cu_admin_write`, and the definers trust that role).
  - Also outside N1: `auth.user_admin_companies(text)` is SECURITY DEFINER with `search_path = public` and no explicit `pg_temp`, so pg_temp is searched first (the 872 definers do not call it).

## As built: N1b — the remaining raw-SQL bypasses

N1 left four tables the approval decision trusts writable by raw SQL as `app_user` (and `platform_admin`). N1b closes them one PR at a time, with 872's pattern: privileges enumerated from the ACL and revoked from every non-owner role, asserted per role in the migration with the deploy-role exemption of #680 (only `session_user`, when it inherits the owner), probed by outcome as each role the runner may become, and proven on the prod-shaped fixture (owner `migration_admin`, non-superuser `postgres`) and the classic one.

- **A — `audit_log` is append-only (migration 880).** UPDATE, DELETE, TRUNCATE and TRIGGER (and column UPDATE) are revoked from every role but the owner; INSERT and SELECT stay. The Q2 sole-approver row the decide writes can no longer be deleted or rewritten by `app_user` or `platform_admin` (`r035-n1b-audit-append-only`: each forgery went through before 880 — DELETE, four UPDATEs, `FOR UPDATE` — and is refused 42501 after; TRUNCATE and TRIGGER were already refused). A company delete still removes its rows (the FK cascade runs as the owner). 880 also refuses to apply while another role inherits the owner, a role is in `pg_write_all_data`, or a view over the table lets another role erase through its owner (`r035-n1b-audit-refusals` runs 880 against each poisoned state; views are followed to any depth and column UPDATE counts; a NOINHERIT member of the owner, and a view chain with mixed owners where the outer owner has no rights on audit_log itself, are the named, undetected limits). Census: `core/auditLogAppendOnlyCensus.test.ts` (no app statement erases, upserts, rewrites or locks the table, strings and comments told apart; every migration but 880, whatever its number, is judged for grants, erases, ALTERs, triggers, rules, views and re-creates of the table, the four pre-880 ones pinned by name). Catalogue: `r035-n1b-audit-catalog.int.test.ts` (privileges, views, function bodies that erase or lock). **Accepted limit (Hein, 2026-10-09):** INSERT stays, so a member can still add a forged extra row — the trail is append-only, not authenticated.
- **B — `approval_rules` and `approval_enforcement` written only through SECURITY DEFINER functions (migration 881).** `approval_rule_lock` / `_create` / `_update` / `_delete` and `approval_enforcement_set` repeat every TypeScript check in SQL: the caller is the session user in the session company (RB020) and passes the routes' write roles (RA008); legacy and offered document types, the input checks, `assertMayDemand`, `assertMayEditRule` with R-048's weakening rule under the row lock; the coupled payment switches, the authority to switch off, the bank control's own-session and verifier-role checks and its switch-on baseline. They write the audit rows themselves, with the shape the TypeScript wrote. Every non-owner write privilege on both tables is revoked; the five writers are EXECUTE for app_user only, the 15 helpers for their owner only (named explicitly — `approval_rule_matches` and `approval_rule_strictest_rank` share the prefix and stay executable by app_user). The TypeScript keeps its checks and runs them first; a SQL refusal (RB001–RB013) maps back onto the same error type and message. Who may create, edit or switch what is unchanged: `r035-n1b-rules-parity` compares route and definer per refusal class and the predicates value by value. Named limits: SQL's rule-name "visible character" test approximates combining marks by whole blocks (Postgres regex has no `\p{M}`) — a rarer mark passes SQL, an unassigned code point inside a listed block is refused by SQL (`r035-n1b-rules-lists` sweeps the BMP); which role name a tied strictest rule shows is arbitrary, as it was in the TypeScript; and the rank the definers judge is `company_users.role`, which an admin could rewrite by raw SQL until C (migration 883). `r035-n1b-rules-lists` also binds every SQL allow-list to its TypeScript constant.
- **C — `company_users` and `company_invitations` enforce the app's role rules (migration 883).** BEFORE row guards judge `current_user`. As `app_user` (withAuth requests, actor `auth.uid()`), exactly the app's rules: an owner or admin acts; roles from the allow-lists; only an owner grants `owner` — by role change, by adding a member, or by invitation, and only an owner re-points or re-opens an invitation that stays `owner` (else an admin rewrites an owner's pending invitation to their own address and accepts it); the last owner is never demoted or removed (counted by person, under a per-company lock); nobody removes themselves; only a membership's `role` changes (moving a membership to another user would hand its role over); an invitation records its sender. As `platform_admin` (admin portal): never `owner`, no invitation writes. Every other role (owners, migration_admin for invite-accept and provisioning, the definer functions, seed scripts) is not judged; any other role's write grant is revoked; TRUNCATE (which fires no row trigger) and TRIGGER are kept to the owners and migration_admin. **Hein's decision (2026-10-09):** an admin may no longer invite someone as `owner` — that was the one app path that granted owner without an owner, and the route now refuses it too. Unchanged on purpose: an admin changing their own role below owner, and demoting or removing a non-last owner (allowed today). 883 refuses to apply while any unaccepted, unexpired owner invitation exists (admins could send or rewrite them until now, and `invited_by` was writable too): cancel them first; an owner re-issues them after the deploy. Named limits: a phantom owner row (a `user_id` that is no user, written by an owner's raw SQL) counts as an owner; a transaction demoting two owners against another doing the reverse can deadlock, and so can an invite acceptance in flight at the instant 883 applies (its lock order is the reverse of section 0's; one side is cancelled and retried); owner memberships an admin granted, and owner invitations already accepted, before 883 cannot be told from legitimate ones and are left alone; raw SQL that forges the claims GUC or can `RESET ROLE` is the N1 boundary (N3).

**Remaining limits after N1b (named, not built):** the **`RESET ROLE` escape** — raw SQL running on the login role, which inherits the owner, can leave `app_user` and write as the owner, or forge the claims GUC (N3, not built); **audit INSERT forgery** — `app_user` and `platform_admin` keep INSERT on `audit_log`, so a member can add a false row (never alter or erase one); **dynamic-SQL writers** — the censuses are text checks and the catalogue tests read static SQL, so a table name or statement built at run time (`'audit_' || 'log'`, `EXECUTE format(...)`) is seen by neither; review of the change is the control.

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
  role ≥ the verifier role; disabling needs a human session and `mayWeakenAtLevel` at the verifier role.
- **Who verifies** (`ap/supplierBankVerifiers.ts`): role ≥ `supplierBankVerifierRole` — the strictest active
  `supplier_payment`/`payment_batch` rule's role but **never below admin** (a refinement of decision 5: a rule may only raise
  it, or an inert low rule lowers who may verify and switch off) — falling back to admin only when nobody who did not set
  the details holds the raised role AND every setter holds it (else a sole owner's own change under an owner-level rule
  is unverifiable; anyone below the raised role having touched the details keeps the raised requirement). Not in
  `bank_details_setters`, except R-035 Q2's sole approver judged on the **admin floor** (no OTHER active member reaches
  admin — so a setter cannot raise the role to qualify alone), recorded `self_verified` with `approval_roster_snapshot`.
  Own role and standing read from the database. Cookie session only (impersonated / claim-less refused).
  Verify sends the fingerprint the verifier saw; the supplier is locked FOR UPDATE and a changed fingerprint is 409.
- **Table**: append-only (app_user SELECT+INSERT; a trigger refuses UPDATE/DELETE/TRUNCATE for every role except the FK
  cascade from a purged supplier); RLS binds tenant and `verified_by = auth.uid()`; a BEFORE INSERT guard binds the row
  to the supplier's current fingerprint, refuses a setter's plain `verified` and any verify while the control is off,
  requires an active member at admin or above, re-reads the roster for `self_verified`, and draws `seq` itself (an
  OVERRIDING SYSTEM VALUE cannot pin a row as "latest").
  Same boundary as N1: it binds code paths, not raw SQL run as app_user.
- **Baseline only on the company's first switch-on** (`bankVerificationEverOn`; the 876 guard refuses a baseline once the
  company has any row from an earlier transaction), so switching off and on cannot accept anything — a pending change, a
  supplier created or given details meanwhile; a setter is shed only when the account
  number's DIGITS change (`bankDetailsChange`), so re-typing the same number cannot clear whoever redirected it.
- **Known limits (review of PR #679)**: a narrow dead end, failing closed — under a raised (e.g. owner-level) payment rule,
  if every holder of that role set the details and someone below it did too (the only owner set the account, an admin
  then changed the branch), nobody can verify until a member with that role who did not set them is added, the rule is
  relaxed, or the owner re-points the account (setters reset to them, and an admin may then verify); the refusal says
  so. The masked account is display-only: the same users can read the full number on the payment pages, and the fingerprint
  (unsalted sha256 of low-entropy fields) is returned to them. The fingerprint covers the five bank columns; Netcash sends
  the supplier NAME as account holder, which it does not cover (a name change redirects nothing — the bank routes on
  account and branch). Payment and batch pages do not yet show the verification state.
- **Not in this step**: a bank-detail edit UI, evidence uploads, employee/payroll beneficiaries, steps 2–5 of the programme.

---
## As built: bank controls (forensic-controls step 2, migration 877)

Hein's decisions 2026-10-09 (goal `.claude/handoffs/2026-10-09-bank-controls-step2-goal.md` §2a). Built on the
R-035 switchboard and step 1's pattern; no second approval kernel, no new allocation document type.

**Shared pieces.**
- `approval_enforcement` accepts `bank_rule` (877 §5): a switch with no rule type (`BANK_RULE` in
  `approvalRuleOptions.ts`), like `supplier_bank_details`. Switching it on needs a person in their own session with a
  role ≥ the bank-rule approver role; off needs `mayWeakenAtLevel` at that role.
- `approvalEnforcement.bankControlRole(companyId, types)`: the strictest ACTIVE rule role of `types`, never below the
  admin floor (`BANK_CONTROL_FLOOR`); `supplierBankVerifierRole` is now that over the payment types,
  `bankRuleApproverRole` that over `manual_journal`.
- `bank/bankControlRefusal.ts`: `BankControlError` (403 who may not / 404 / 409 state moved, with a `code`),
  `assertHumanSession` (impersonation → `IMPERSONATION_FORBIDDEN`; a claim-less or MCP context — no `session_id` —
  → `AGENT_FORBIDDEN`), `isSoleAtFloor` (R-035 Q2 judged on the admin floor), `rosterSnapshot`.
  `bank/bankControlResponse.respondIfBankControlRefused` answers it on routes.

**A. Importer ≠ allocator (decision 2).**
- Provenance (877 §1): every path that writes lines with an `import_batch_id` writes a `bank_import_batches` row
  naming the person (`imported_by`) and the channel (`import_channel`: `upload`, `mcp`, `extension`,
  `statement_ocr`, `classified`), with `file_sha256` where there is a file. `bank-transactions-import-classified`
  and the statement-OCR commit used to set `import_batch_id` with no batch row at all; both write one now. For OCR
  the importer is the UPLOADER (the import's creator, else the captured document's uploader, else the committer):
  whoever supplied the file's contents. MCP `import_bank_statement` records the token's user; `undo_bank_import`'s
  boundary is `import_channel = 'mcp'` (or a legacy `mcp:%` importer). Provenance never changes once set (877
  trigger). Census: `tests/unit/services/bank/bankImportProvenanceCensus.test.ts`.
- The gate (`bank/bankLineImporterGate.ts`): under enforcement of the arm's TYPE (no matching rule needed) —
  `manual_journal` for account / split / transfer and a customer REFUND (money out to a customer), `supplier_payment`
  (either coupled switch) for a supplier outflow — the line's batch importer may not allocate it: 403
  `IMPORTER_MAY_NOT_ALLOCATE`, before any write, read under the line lock where the site holds one. `importerArmOf`
  is the one arm mapping (allocate, split, the rule sweep, the provisional poster, the MCP bulk classifier, the
  reversal gate). Exempt: feed lines, money in (receipts, supplier refunds), a batch naming nobody (no row, a legacy
  `mcp:*` importer). Importer ids compare case-insensitively. Sole-approver exception: R-035 Q2 on the admin floor,
  judged only for the request's own user (a sweep acting for someone else is never sole — fails closed).
- MCP: allocate, split and apply-supplier-payment refuse before any write and their dry runs agree; the bulk
  classifier skips importer-held lines as `approval_required: …` in the dry run and the real run alike.
- Sweeps act for the person who triggered them (decided per the goal's recommendation): `sweep(…, triggeredBy)` is
  required and server-derived — the import's own sweep runs for the batch's importer (journals keep the zero-uuid
  `created_by`), rules applied / smart-categorise / the LLM pass for the session user. Importer-held lines are
  skipped `approval_required` and counted.

**B. Bank-rule history and approval (decision 3).**
- History is captured by the DATABASE: an AFTER trigger on `bank_categorisation_rules` writes one
  `bank_rule_changes` row (status `applied`, before/after projections, `proposed_by = auth.uid()`) for every write
  that changes the rule, whoever writes — UI, MCP, seed (declared `seed`), customer merge (declared `merge`), raw SQL.
  No-op writes record nothing. An `applied` row can only come from that trigger (the insert guard refuses one at
  trigger depth 1).
- Whether a change needs approval is SQL (`bank_rule_change_needs_approval`): afterwards the rule auto-posts
  (`is_active AND auto_create_entry`) and either it did not before, or any non-cosmetic column moved (cosmetic:
  `rule_name`, `description_template`, `notes`). So a match pattern, priority, account, supplier, customer, VAT code or
  `auto_apply` change on an auto-posting rule is held; turning auto-post off, disabling, deleting and suggestion-only
  rules apply at once. `auto_apply` is TEXT `fifo`/`none` in the schema (how a supplier rule's cash is applied), so
  it is a posting target, not the switch.
- Held changes: `bank/bankRuleChangeControl.ts` (the ONLY writer of the rules table — census
  `bankRuleChangeCensus`) inserts a `pending` row and applies nothing; the create route then never runs `applyRules`.
  A newer change to a rule supersedes its undecided pending ones (877 trigger).
- Status transitions are append-only DECISIONS (`bank_rule_change_decisions`: approved / rejected / superseded; one
  per change, UNIQUE), never an UPDATE: no UPDATE grant exists on either table, and a SECURITY DEFINER status writer
  would have been a second privileged writer to census. State is derived (`bank_rule_change_states`).
- Who decides (`bankRuleApprovers.ts`, `bankRuleChangeDecision.ts`): a person in their own session; own role (read
  from the DB) ≥ `bankRuleApproverRole` (strictest active manual-journal rule, never below admin), with step 1's
  fallback to the floor when no non-proposer holds a raised role and the proposer does; not the proposer, except as
  the sole approver on the admin floor (roster recorded). The digest (`sha256` of `[kind, rule_id, before, after]`)
  must match; an approval whose rule moved since is 409. The DB guard re-checks the floor, the proposer, the roster,
  pending-ness and staleness; the raised role is TypeScript's. Approval applies `after` atomically
  (`bank_rule_change_apply`). Refusal order: session 403 → 404 → not pending 409 → digest 409 → who 403 → stale 409.
  Normally a stale approval surfaces as `CHANGE_NOT_PENDING` (any write supersedes first).
- Backstop: under the switch, the rules table refuses (23514) any write that needs approval unless it applies a
  change approved in the same transaction — a missed code path fails closed.
- MCP may propose (the tool reports "held for approval") and never decide (no tool; the route refuses an agent
  context 403 `AGENT_FORBIDDEN`). A customer merge naming an auto-posting rule is refused 409 `RULE_MERGE_HELD`
  under the switch (turn auto-post off, merge, propose again). Deleting a missing or foreign rule is 404, all or
  nothing for a batch.
- UI: Pending changes panel above the rules table (Approve / Reject only where `canDecide`), a per-rule badge, held
  saves reported as held; the `bank_rule` row in the enforcement panel (preview: active auto-posting rules).

**C. Reversals (decision 4).** One choke point, `reverseReconciledTransaction` (`bank/bankReversalGate.ts`), after
the line lock and before any write: under enforcement of the arm's type (plain journal → `manual_journal`; supplier
payment or batch on an outflow → `supplier_payment`; a customer refund → `manual_journal`; receipts ungated), a
non-human session is refused (`AGENT_FORBIDDEN` / `IMPERSONATION_FORBIDDEN`), and the allocator — the union of the
root journal's, the payment document's and the auto-post run's `created_by` (zero uuid = nobody) — may not reverse
unless sole on the admin floor (403 `ALLOCATOR_MAY_NOT_REVERSE`). Each permitted reversal under enforcement writes
`audit_log` (`reverse`, `bank_transaction`, metadata allocator / armType / soleApprover). The MCP reverse tools
(single, batch, range — dry run alike) pre-check and refuse agents when the arm is enforced. `undoRun` and
`undoAnyway` are judged at the run level, up front (run creator; zero-uuid import run belongs to nobody), with an
`bank_auto_post_run` audit row when anything was undone. Void receipt / payment reach the choke point.

**D. Auto-post settings (decision 5).** `updateAutoPostSettings` reads the row under lock (or the defaults the gate
applies), writes nothing for a no-op, and audits every change field by field (`create` / `update`,
`bank_auto_post_settings`). Under `manual_journal` or `supplier_payment`/`payment_batch` enforcement a WEAKENING change
— enabling auto-post or the LLM tier; raising a cap, or setting one to 0 (no cap: the gate skips a line only when
cap > 0); lowering a minimum confidence — needs a person in their own session and `mayWeakenAtLevel` at
`bankControlRole` over the ENFORCED types only (a dormant rule of an unenforced type does not raise it); otherwise
403 `WEAKENING_REQUIRES_AUTHORITY` before any write, with a `log.warn`. A mixed patch is judged whole.
Strengthening is always allowed. Census: `autoPostSettingsWriteCensus`.

**E. Transfers (decision 6).** Under `manual_journal` enforcement and a rule matching the amount, Banking > Transfers
saves the transfer as a DRAFT journal (the same two bank legs, source `auto_bank_transfer`, marked `manual_journal`,
`created_by` the person) and raises the approval request as the person; 202 `{ status: 'awaiting_approval', journalId,
requestId, requiredRole }`. Order kept: Login-as refused → bank accounts → duplicate guard (428) → decision. After
approval the creator posts it through `journal-entries-action` (gated, cleared). While held, its statement line
allocated as a transfer is refused naming the draft (`transferDuplicateGuard`, while the request is pending or
approved-unposted; a rejected draft no longer blocks). Known change: under enforcement a held transfer into a
closed period or inactive account now fails at post, not before the write. Enforcement off or no rule matching:
posts as before.

**Review round 1 (PR #684; blind reviewer + adversarial breaker at 96595543), changes:**
- **Rules that post money (Hein, 2026-10-09, breaker REPRO 4):** suggestion rules feed the unattended auto-post sweep
  (rule matches score 0.95), so under `bank_rule` a rule POSTS MONEY when it is active AND (`auto_create_entry` OR the
  company's auto-post is enabled) — `bank_rule_posts_money(company, p)`, `bank_rule_change_needs_approval(company,
  before, after)`; the one-argument predicate is dropped. With auto-post on, creating or re-pointing any active rule
  needs a second person; disable and delete stay immediate. Under `bank_rule`, enabling or loosening auto-post is a
  weakening too (D), at no less than the bank-rule approver role. This supersedes "suggestion-only rules apply
  immediately" while auto-post is on.
- **GL reversal of a bank allocation:** `journal-entries-action` `reverse` and MCP `reverse_journal_entry` lock the
  journal chain's statement lines first (D12's entrance, bank lines before journals) and, under the arm's enforced
  type, refuse 409 `REVERSE_FROM_BANK_LINE` — reverse it from the bank line, where the allocator, agent and audit
  rules apply (`bankReversalGate.lockJournalCashForGlReversal`). Enforcement off: unchanged.
- **Provisional Dismiss** is a reversal: the same allocator / agent check under the line locks, audited per line.
- **Matching** (`bank-transactions-action` `match`, `bank-match-confirm` journal line / bank transfer): the importer
  may not match their batch's line to a journal they created (403 `IMPORTER_MAY_NOT_ALLOCATE`); `auto_match` is not
  gated (an unattended pairing of existing entries).
- **Provenance cannot be shed:** a batch a line names cannot be deleted (until the company is purged), and a line's
  `import_batch_id` cannot change once set (877 triggers).
- **The raised approver role is enforced in SQL too** (`bank_rule_approver_role`, `bank_control_rank` — the ladder,
  pinned to `APPROVER_RANK` by census — with the same proposer fallback as `bankRuleApprovers.ts`).
- **Rule targets:** 489's composite FKs nulled `company_id` with the target, so deleting any supplier or GL account a
  rule named always failed (pre-existing); 877 re-creates them as `ON DELETE SET NULL (supplier_id)` /
  `(gl_account_id)` (PG15+; skipped on older servers). A cleared target re-points money, so under `bank_rule` the
  soft-delete purge and the migration rollback first disable the rules that would need approval
  (`disableRulesLosingTarget`, recorded; re-enabling is held), in the same savepoint as the delete.
- Every route whose call graph can raise `BankControlError` answers it (403/409) — census-pinned; the allocator and
  the run creator compare case-insensitively; the dead legacy `importBankStatement` (batch-id lines with no batch row)
  is deleted.
- Disputed, with reasons in the PR: the importer check has no amount threshold (decision 2 sets none; a hand-keyed
  line below a manual-journal rule's threshold is R-035 PR6's design), and extension lines are feed lines (decision 2).

**Review round 2 (PR #684 at bf371012), changes:**
- **Auto-match acts for whoever ran it:** `autoMatchTransactions(…, triggeredBy)` is required and fails closed. It skips, and counts, a pair where that person imported the line and also created the journal or payment.
- **The match gate judges the arm of what the line is matched to** (`allocationFacts`, shared with the reversal gate): a supplier payment or batch leg is `supplier_payment`; a plain journal or a customer refund is `manual_journal`.
- **Reversing a matched document is a reversal:**
  - voiding a supplier payment, cancelling a customer refund, or reversing a batch whose bank leg a statement line is matched to runs `assertMayReverse` for each matched line before any write, and audits it;
  - the R-127 settlement undo (voiding a fully unapplied settlement payment) is gated and audited like Dismiss.
- **Seeding under `bank_rule`:** seeded rules that would post money (auto-post on) are held, one pending creation each; the rest apply as before.
- **A line's provenance is fixed:** `import_batch_id` and `bank_feed_connection_id` cannot change in either direction (877).
- **Switching auto-post on under `bank_rule`** is refused with 409 `AUTO_POST_RULES_UNREVIEWED` before any write. The refusal names each affected rule, who changed it and when. The way out: disable the rule and re-activate it through approval, or put the change back. It fires when an active rule meets both conditions:
  - its state now, compared with its state at the cutoff, would have needed approval with auto-post on;
  - someone other than the person switching it on made an unapproved applied change to it in that span.
  How it is built:
  - The cutoff is the later of `bank_rule`'s `enabled_at` and `bank_auto_post_settings.disabled_at`. `disabled_at` is set only by a trigger on an on → off change; a delete and re-insert can only move it earlier.
  - Rule writers take a per-company advisory lock shared, and the settings writer takes it exclusive, before anything else (`bank/bankRuleAutoPostLock.ts`), so a concurrent rule change waits and is then held.
  - The owner switching auto-post off, editing and switching it back on alone is an accepted risk (breaker round 2). It needs exactly the authority that switches `bank_rule` itself off, and every step is audited.

**Review round 3 (PR #684 at b51bdfbc), changes:**
- **The auto-post-on re-check orders changes by when they were written, not when their transaction began.**
  - `bank_rule_changes.recorded_at` is `clock_timestamp()`, set after the shared lock; `disabled_at` is also `clock_timestamp()`.
  - Switching `bank_rule` on takes the same lock exclusive (`lockOutRuleWriters`).
  - So an edit whose transaction began before a switch-off, or before the enable, is still counted.
  - The lock order is census-pinned: the customer merge takes the shared lock after its own row locks, before any rule. That cannot deadlock, because the exclusive holders lock only the settings row and the switch.
- **The batch reversal route** answers `BankControlError` 403. The census's list of throwers was re-derived from the call graph.
- **Accepted, stated:** whoever may switch auto-post on is not blocked by their OWN unapproved rule changes, in any company. That authority already switches `bank_rule` off, and both acts are recorded.

**After #690 (R-035 N1b, migration 881) merged into this branch:**
- 881 writes every switch through the SECURITY DEFINER `approval_enforcement_set`, and app_user lost its direct writes on `approval_enforcement`. Its list of types does not include `bank_rule`.
- **Migration 885** redefines the function from 881's own text, adding only the `bank_rule` branch:
  - a person in their own session (RB012);
  - switching on: the actor's own role ≥ `bank_rule_approver_role` (RB014), then the per-company rule-writer advisory lock is taken EXCLUSIVE before the insert;
  - switching off: `approval_rule_may_weaken` at that role (RB011);
  - 881's audit path.
- Every other branch is byte-identical. 885 re-asserts 881's catalogue checks, and the n1b md5 pins are updated.
- The TypeScript keeps the same checks first, for the typed refusal.
- Verified on a prod-topology copy (`docs/evidence/bank-controls-step2/prod-topology-877.txt`).

**Known limits.**
- Browser-extension ingest lines carry `bank_feed_connection_id`, so they are feed lines and exempt from
  importer ≠ allocator (decision 2). The extension reads the bank's page in the user's own browser.
- `bank-transactions-import-classified` writes `bank_transactions.suggested_cost_centre`, a column no migration
  creates (pre-existing; the route 400s on a schema built from migrations).
- Turning auto-post on is checked in application code; raw SQL as app_user can still flip `bank_auto_post_settings.enabled`.
- Same boundary as N1 and 876: the objects bind application code paths and app_user statements, not an attacker
  already running arbitrary SQL (who can reset the role or set claims).

---
## As built: entity change history (forensic-controls step 3, migration 888)

Hein's decisions 2026-10-10 (one batch, every recommendation taken): (1) the full master set; (2) values stored in
full, masked to the last four for everyone, owner / admin may reveal; (3) read API + per-entity History UI + a
company-wide page + an MCP read tool; (4) reading follows the entity, payroll from manager up, the feed and
everything else owner / admin, enforced in RLS too. Retention: until the company is purged.

**Capture is the database's, not the services'.** The census (`entityChangeCensus`, every writer pinned per table)
found 100+ writer sites — routes, MCP tools, the platform-admin portal, Sage commit, invite acceptance, scripts and
SECURITY DEFINER functions (881/885, `create_company_with_owner`) — and none recorded old → new values (only
approval rules, six payroll fields and bank rules had any). So one generic AFTER ROW trigger,
`entity_change_capture(entity_type)`, ENABLE ALWAYS (it fires under `session_replication_role = replica` too), sits
on suppliers, customers, gl_accounts, payroll_employees, company_users, company_invitations,
company_user_permissions, companies, approval_rules and approval_enforcement. It records the row's projection before
and after, the changed keys, and:
- **actor** `auth.uid()`, else `db:<login role>`; **channel** `session` / `impersonation` (+ `impersonator` from
  `impersonation_sessions`) / `token` (claims without `session_id`: MCP, PAT, extension) / `platform_admin` /
  `system` (no claims); `db_role` (the role the session SET, which a definer does not change — so a write inside
  881's `approval_enforcement_set` is the person's, `app_user`), `login_role`, `txid`, `recorded_at`.
- No-op writes record nothing. The projection is every column (a column added later is recorded) minus id /
  created_at / updated_at and derived or secret ones (`bank_details_setters`, `is_default`, the invitation token
  and mail state); companies is an allow-list (tax, VAT, bank, year-end, lockdown, currency / FX, Netcash on/off,
  status, idle timeout), and the two Netcash keys are recorded as a 12-hex sha256 digest, never the key.
- A row moved between companies is recorded in both; a row deleted by a company purge records nothing (its FK would
  refuse it).

**Append-only, stronger than 877.** The capture is SECURITY DEFINER, so nobody else needs INSERT: app_user holds
SELECT only — on every column but `seq` and `txid`, platform-wide counters that would let a member count other
tenants' writes (review rounds 1–2) — platform_admin nothing, and EXECUTE on the capture and its helpers is the owner's alone (so it cannot
be attached to a temp table of one's own to forge a row; a trigger fires without an EXECUTE check). A BEFORE INSERT
guard refuses any insert not made from inside a capture (trigger depth) and stamps seq / clock / txid; BEFORE UPDATE /
DELETE / TRUNCATE refuse every role's plain statements, the owner's included, except the cascade of a purged company.
The owner — the role that applied 888, which on production is the app's own login (`deploy.sh` migrates with the app's
`DATABASE_URL`), not `migration_admin` — can still disable or drop the guards, or forge a row from a trigger of its own
(trigger depth is met by any trigger): injected SQL that RESETs ROLE can erase history (breaker #696 R7). That is the
N1/N3 boundary: the same login already owns every tracked table through `migration_admin` and can switch the capture
off. Closing it needs a history owner the login is not a member of (and, on PG < 16, a superuser to give that role
BYPASSRLS) — part of N3, not built here. 888 asserts all of
it — per role, exempting only `session_user` when it inherits the owner (#680) — plus that every tracked table carries
the capture ENABLE ALWAYS, that no request role holds TRUNCATE on a tracked table (TRUNCATE fires no row trigger),
and that the capture's owner bypasses RLS (FORCE RLS would otherwise refuse every tracked write).

**Reading.** RLS (`entity_changes_read`): the company GUC and membership, then suppliers / customers / GL accounts
for any member, payroll employees for owner / admin / manager, the rest for owner / admin. The same rules in
`entityChangeTypes.ts` (bound to the SQL by test): `GET /api/accounting/entity-changes` (a timeline needs
`entityType` + `entityId`; without an id it is the feed, owner / admin), `POST /api/accounting/entity-changes-reveal`
(owner / admin, a person in their own session — Login-as and tokens refused — `audit_log` `export` /
`entity_change` in the same transaction); paging is newest first by `(recorded_at, id)` with the last change's id as the
cursor, and a cursor that is not a change of the same history is refused (400 / MCP error), never an empty page; MCP `entity_history` (masked always; `read:payroll` for employees, the
feed filtered to employees included). UI: History tab on suppliers and customers, Record changes on the employee
page, a History drawer on every chart-of-accounts row and bank-account card, Accounting → Change History.

**Definer-aware (N1b).** approval_rules / approval_enforcement are written only by 881/885's definers and
company_users / invitations are judged by 883/886's guards: the capture runs inside those as their owner but
reads the request's claims, so the person is recorded; the N1b catalogue pins now admit exactly this one AFTER
trigger on those tables (it writes only entity_changes and returns NULL, so it cannot change a row a guard judged).

**Verified:** integration suites on a disposable fixture (`entity-changes-capture`, `-boundary`, `-routes`; red
before 888), the census and unit pins, a prod-topology copy (`docs/evidence/entity-change-history/prod-topology-888.txt`:
owner `migration_admin` non-superuser, deploy role non-superuser BYPASSRLS; the tripwire refuses a second member of
the owner), the mutation proof (`mutation-proof.txt`), browser screenshots. On the prod-topology copy the tables 888 alters are owned by
`migration_admin`; `entity_changes` and the capture are owned by the applying (deploy) role.

**Known limits.** The N1 boundary (raw SQL that RESETs ROLE or forges claims — N3). History starts at deploy. Writes
with no claims (invite acceptance on the migration_admin pool, provisioning, scripts) are `db:<role>` / `system` — the
new member is in the row itself. `payroll_bank_details` is untracked (no company_id, no app writer). Names resolve
only for current members (`approval_company_member_name`); a platform admin behind Login-as shows as an id. Readers
order by `recorded_at` (the database clock at capture), not the hidden platform-wide `seq`: a backwards clock step on
the server could show two changes in the wrong order (no tie or reversal was seen in 12 000 captured rows). Cost: about
0.4 ms per tracked row written (a 5 000-row bulk insert or update takes ~2 s instead of ~0.1 s), so the Sage, chart and
customer imports slow down and write a history row per row.

**Open for Hein (review of PR #696, M2): erasure.** The history keeps a deleted employee's ID, passport and tax numbers,
date of birth and equity fields, and a deleted supplier's bank account, in full (masked on screen) until the company is
purged; nothing can erase one person's rows short of owner DDL. Retention of accounting and payroll records is a legal
obligation for years, which this serves; whether POPIA needs a per-person redaction path (owner-run, audited) is a
product decision, not built here.
