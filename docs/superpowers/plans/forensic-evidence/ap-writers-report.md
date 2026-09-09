# AP shared writer enforcement — 2026-09-09

Worktree base: `93ea3768`. This bounded task connects the existing supplier payment process/void and supplier invoice approve/post/cancel shared services to the approval kernel. It does not claim that separate batch, bank settlement, capture/import or direct CRUD writers are already protected by this integration.

## Interfaces and ingress

Existing company/id/user positional parameters and return types remain. Invoice approve/post and payment process accept an additional optional `approvalId` in their existing options object; payment void/invoice cancel accept that reference in an optional last options object. The service obtains the active branded control context itself and requires the supplied company and person to match. Caller amounts, approver identities and skip flags never enter the authority decision.

`ApApprovalRequiredError` carries `OPERATION_APPROVAL_REQUIRED`, a safe message, operation and entity reference. Existing REST error envelopes remain unchanged. The single action routes validate the UUID reference; the bulk invoice route accepts an optional UUID-to-UUID `approvalIds` map so each entity uses its own approval.

Verified source ingress inventory:

- REST/UI: `supplier-payments-action.ts` process/void; `supplier-invoices-action.ts` approve/cancel; `supplier-invoices-bulk-action.ts` approve/post/cancel.
- MCP existing callers: `writeSupplierInvoices.ts`, `writeBulkApproveSupplierInvoices.ts`, `writeSettleByContra.ts` call these same shared services. Root owns forwarding approval references and the final MCP transport proof.

Invoice approve/post now share one financial effect and stored invoice result. Posting a draft sets it approved, eliminating the former posted-but-draft split. The post adapter preserves `{ journalEntryId, alreadyPosted }`; approval returns `SupplierInvoice`. Parent permits authorize only explicitly registered child journals: new AP journals persist `source_record_id`, registration verifies the owned parent relationship, and the permit travels through post/reversal calls. No public bypass flag exists.

## Material and events

`apControlAccounts.ts` resolves current active system-account subtype mappings without the legacy 60-second cache. It uses existing account-type/subtype semantics, refuses missing or ambiguous mappings, locks owned GL rows, and retains explicit line/bank accounts and linked journal header/lines as binding material. Both the materializer and financial writer use this resolver. Changing a chosen account or line coding therefore changes the authoritative binding before effects.

Gross-inclusive lines already supported by the AP writer remain accepted by the materializer when their sum reconciles to the authoritative invoice total. Currency remains derived from owned invoice data without a guessed default.

The kernel records payment/invoice parent financial events. Payment allocation application/unapplication additionally reads owned allocation amounts, captures each invoice's real before/after state and advances its version under the same parent permit and transaction. An untracked child receives `baseline_observed` before mutation. Draft payment status approval now requires an active actor, records its observed baseline and `status_approved` event, and does not bypass the later financial approval gate.

The oversized invoice workflow was split into an unchanged three-way-match implementation and mapping/expense-line helpers. Each new/edited source file remains under 300 lines.

## Evidence status

Unit RED evidence:

- `/tmp/ap-writers-unit-red.log`: four unauthenticated shared financial services reached their old effects instead of refusing.
- `/tmp/ap-writers-permit-red.log`: a fresh `requireControlTx()` in the same request incorrectly invalidated its parent permit. Named fix `af3a19c0` validates both active contexts and their common principal object; nested-effect tracking also keys that principal.
- `/tmp/ap-writers-route-red.log`: all three action routes omitted the supplied approval reference.
- `/tmp/ap-writers-accounts-red.log`: shared uncached account resolver did not exist.
- `/tmp/ap-writers-gross-lines-red.log`: legacy gross-inclusive invoice representation was rejected.
- `/tmp/ap-writers-status-red.log`: draft payment approval did not require the active actor.

Current focused units: 12 pass, including reversal target selection. Focused TypeScript compilation including the AP integration suites passed, and source/routes ESLint passed.

Actual PostgreSQL: 24/24 pass (7 AP shared writer cases and all 17 prior kernel adversarial cases), 7.09s, `/tmp/ap-writers-pg-second.log`. The first run reproduced fixture payment-number width failure and the old PAT test ceiling missing the newly required `write:bank-tx`; both fixtures were corrected without changing refusal assertions. The successful run uses real app_user RLS, withControlRequest, withAuth/CSRF/error wrappers and existing REST business handlers. Only external GoTrue cookie verification and auth-pool selection are synthetic; no HTTP socket/browser or deployed admission claim is made.

Proven AP scenarios: REST and shared-service missing-approval refusal before effects; real payment posting, invoice settlement events and independently approved void; canonical invoice approve/post returning one journal; changed account mapping and invoice coding rejection; failed posting rollback with approval reusable on retry; status-approval events without financial bypass; closed-August original journal reversing into the open SAST September target and refusing a different requested target before callback.

Reversal material binds and locks the original journal/period, actual target period and selected accounting date. Child reversal receives the permit's frozen accountingDate; settlement unapplication uses the same date. Root dependencies are dispatcher `3a9c7198`, `3f74ebda`, `208e2fab`, AP date normalization `35236915`, GL writers `04b6183a`/`61992f53` and relationship registration through `eb56d6d1`. The additional child posting-date guard `80a35820` arrived after the 24-test run. Its final focused AP PostgreSQL rerun passed all 7 cases (4.25s, `/tmp/ap-writers-pg-date-final.log`), including successful bound-date posting/reversal. Fresh 12 unit tests and focused TypeScript compilation also passed after that dependency (`/tmp/ap-writers-unit-date-final.log`, `/tmp/ap-writers-typecheck-date-final.log`). DB lease was released after completion. Named writer commit: `f62b94cb`. No production or external provider calls occurred.

Reproduce with Node22.23.1 on PATH, dedicated synthetic fixture URL and explicit opt-in supplied at runtime:

```sh
./node_modules/.bin/vitest run tests/unit/services/ap/forensic*.test.ts
./node_modules/.bin/vitest run --config vitest.integration.config.ts tests/integration/controls/apSharedWriters.int.test.ts tests/integration/controls/operationApproval.int.test.ts
```

No CI/build or migration changes were performed.

## Remaining writer inventory

The following paths still require their own bounded controls/event integration and end-to-end proof; source existence is not an assertion that every path is exploitable:

- `ap/supplierInvoiceService.ts`, `ap/supplierPaymentService.ts`, and `supplier-invoices-detail.ts`: creation, editing, deletion and line replacement.
- `ap/batchPaymentService.ts`, Netcash/EFT release adapters: parent batch approval, beneficiary exposure and external outbox release.
- `ap/supplierBankPaymentService.ts`, `supplierPaymentApplicationService.ts`, `supplierAllocationLines.ts`, `supplierAutoAllocate.ts`, `bank/bankAllocationUnwind.ts`, `bank-match-confirm.ts`: separate bank cash application and unwind paths.
- `capture/[id]/post.ts`, `ai-invoice-pipeline.ts`, `capture/fourWayMatchService.ts`: capture posting and match mutation. Current AP material fingerprints detect changed monetary/line facts; they do not invent missing prior event history for these writers.
- `ap/migrationApService.ts`, `core/sageImportService.ts`, `core/recurringTransactionService.ts`: import and recurrence writers.
- `core/softDeleteService.ts`, `core/archiveExecutionService.ts`: bulk lifecycle changes. Separate supplier merge integration now refuses financial/banking/approval dependencies; that parallel work is not included in this AP commit.
- `ar/creditNoteApproveService.ts`, `ar/creditNoteCancelService.ts`, `ar/invoiceStatusRecompute.ts`, `reports/drcVatService.ts`: additional AP row mutation call sites requiring domain-specific review.
- Extracted `supplierInvoiceThreeWayMatch.ts`: existing match-state/cache mutation is preserved, not claimed as a newly event-complete writer.
