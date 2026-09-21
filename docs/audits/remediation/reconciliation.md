# Source reconciliation

Numbered inventory: 76 A sources (C1–C21, H1–H55) and 54 B sources (F01–F54), all mapped. 129 distinct K rows carry 140 numbered-source associations; 10 sources span multiple K rows. There are no unmatched numbered IDs. At import, all 281 K rows were candidates; current dispositions live in backlog.json. Mapping does not establish a defect, severity, completed reproduction, or fix.

## Method and boundaries

Compared preserved A claims and locations with the K claim and affected path; compared each B title with its preserved article source/evidence and the K claim. Labels alone were insufficient: the importer missed BB Fxx and AA Cxx labels, and several A rows combine independent paths. `canonicalItems` preserves every split target; `canonicalItem` stays null for splits. Approved corrections annotate both sources and target candidates; original claims remain preserved. A H50 spans K-096 activation and K-269 authorization capture: shared source does not yet establish duplicate root cause.

## Numbered mapping

| Source | K counterparts | Reported location |
|---|---|---|
| A C1 | K-031 | services/reports/sarsEfilingSubmissionService.ts:128   pages/api/accounting/sars/sars-vat201.ts:35 |
| A C2 | K-039 | services/practice/practiceClientRateOverrideService.ts:98   services/practice/practiceStaffRateService.ts:112 |
| A C3 | K-033 | modules/billing/services/subscriptionBillingService.ts:127 |
| A C4 | K-006 | pages/api/accounting/opening-balances.ts:107 |
| A C5 | K-007 | pages/api/accounting/goods-received.ts:39-49 |
| A C6 | K-040 | services/practice/practiceWipService.ts:143-260 |
| A C7 | K-022 | services/payroll/payrollLoanService.ts:422-464 |
| A C8 | K-011 | services/ar/creditNoteCancelService.ts:145-164 |
| A C9 | K-030 | services/loans/loanScheduleService.ts:89-92 |
| A C10 | K-012 | services/ar/statementEmailService.ts:130 |
| A C11 | K-015, K-089 | services/ap/migrationApService.ts:74   services/core/migrationImportService.ts:136 |
| A C12 | K-008 | services/core/nlQueryValidationService.ts:119 |
| A C13 | K-009 | services/core/migrationExecuteService.ts:224 |
| A C14 | K-016 | services/bank/bankAllocationService.ts:242-247,402-413 |
| A C15 | K-017 | services/bank/bankRulesMatchingHelpers.ts:125-158   services/bank/bankRuleAutoPostLine.ts:131-140   services/gl/ruleVatResolution.ts:57-59 |
| A C16 | K-018 | services/bank/openBankingSyncService.ts:22-41,188-202 |
| A C17 | K-004 | services/capture/captureInboxService.ts:47-53   services/capture/inboundEmailService.ts:84-98 |
| A C18 | K-005 | services/capture/whatsAppInboundService.ts:86-106 |
| A C19 | K-036 | pages/api/webhooks/paystack.ts:227-240   pages/api/portal/payments/paystack/verify.ts:80-96 |
| A C20 | K-003 | pages/api/bureau/clients.ts:59-72   modules/bureau/services/bureauService.ts:149-159 |
| A C21 | K-037 | pages/api/admin/payroll/sars-codes/release.ts:40   import.ts:143   [code].ts:58 |
| A H1 | K-079 | services/payroll/payrollJournalBuilder.ts:121 |
| A H2 | K-080 | services/payroll/etiEngine.ts:66 |
| A H3 | K-068 | pages/api/accounting/supplier-statement-detail.ts:44,54,65 |
| A H4 | K-093 | pages/api/accounting/reports/sales-by-customer.ts:33 |
| A H5 | K-061 | pages/api/accounting/customer-merge.ts:63 |
| A H6 | K-103 | src/lib/rateLimit.ts:90 |
| A H7 | K-091 | services/afs/cashFlowReconciliationService.ts |
| A H8 | K-092 | pages/api/accounting/afs/images.ts:16 |
| A H9 | K-074 | pages/api/accounting/bank-match-confirm.ts:1639-1735 |
| A H10 | K-094 | pages/api/accounting/income-statement-xlsx.ts:225-374 |
| A H11 | K-062 | pages/api/accounting/customer-statement.ts:86-163 |
| A H12 | K-053 | services/ar/arAgingService.ts:53   services/ap/apAgingService.ts:87   services/ar/arSubledgerService.ts:83   services/ap/apSubledgerService.ts:51 |
| A H13 | K-063 | services/ap/supplierAllocationLines.ts:29   services/ap/supplierAutoAllocate.ts:74 |
| A H14 | K-064 | services/ap/batchPaymentService.ts:78-99 |
| A H15 | K-054, K-065 | services/ar/customerPaymentAllocationService.ts:39-90   services/ap/supplierPaymentWorkflowService.ts:56-114 |
| A H16 | K-066 | services/ap/supplierPaymentService.ts:139-181 |
| A H17 | K-013, K-044 | services/ar/recurringInvoiceService.ts:131-143   services/core/recurringTransactionService.ts:191 |
| A H18 | K-055 | services/ar/writeOffService.ts:69-96,98-163 |
| A H19 | K-056 | services/ar/disputeService.ts:302-315 |
| A H20 | K-081 | services/loans/loanPeriodCloseService.ts:54-66,159-186 |
| A H21 | K-082 | services/loans/loanComplianceService.ts:281-285 |
| A H22 | K-083 | services/loans/loanGlPostingService.ts:148-210 |
| A H23 | K-085 | pages/api/accounting/stock-adjustments.ts:47   migrations/244b_inventory.sql:101-119 |
| A H24 | K-086 | pages/api/accounting/stock-adjustments.ts:41,46   services/items/stockValuationService.ts:51 |
| A H25 | K-057, K-102 | services/ar/creditNotePdfBuilder.ts:33   services/ar/portalService.ts:111,145-157 |
| A H26 | K-058, K-073 | services/ar/debtorsManagerService.ts:115,163,214   services/bank/bankMatchDbQueries.ts:107-108 |
| A H27 | K-059 | services/ar/dunningCronService.ts:114-119 |
| A H28 | K-067 | services/ap/eftService.ts:45-48,120-125 |
| A H29 | K-060 | services/ar/quoteService.ts:85-93 |
| A H30 | K-043 | services/gl/approvalService.ts:230 |
| A H31 | K-087 | services/core/migrationOpeningBalanceService.ts:61 |
| A H32 | K-088 | services/core/sageImportService.ts:365 |
| A H33 | K-075, K-076 | services/core/ocrExtractionService.ts:146,156 |
| A H34 | K-045 | services/core/documentStorageService.ts:83 |
| A H35 | K-046 | services/gl/yearEndJournalBuilder.ts:70 |
| A H36 | K-047 | services/gl/assetDepreciationPosting.ts:112 |
| A H37 | K-048, K-049 | services/gl/recurringJournalService.ts:77   pages/api/accounting/recurring-journals-action.ts:46 |
| A H38 | K-090 | services/core/sageCustomerImportService.ts:121   services/core/sageImportService.ts:475 |
| A H39 | K-050 | services/gl/closeReadinessChecks/arSubLedgerCheck.ts:33   apSubLedgerCheck.ts:35 |
| A H40 | K-051, K-052 | services/gl/accountMergeGuards.ts:154   services/gl/reclassification/planGuards.ts:84 |
| A H41 | K-069 | services/bank/bankAllocationService.ts:655-666   services/bank/bankTransferAutoLink.ts:82-101 |
| A H42 | K-020 | services/bank/bankReconciliationService.ts:262-277,151-178 |
| A H43 | K-070 | services/bank/bankRuleAutoPostLine.ts:158-251 |
| A H44 | K-071 | services/bank/bankImportService.ts:219-294 |
| A H45 | K-072 | services/bank/receiptToJournalService.ts:56-69,114-145 |
| A H46 | K-077 | services/capture/imapMirrorService.ts:216-230   services/capture/captureRouterService.ts:59-70 |
| A H47 | K-078 | services/capture/supplierRulesService.ts:197-276 |
| A H48 | K-041 | pages/api/invitations/[token]/accept.ts:54-57 |
| A H49 | K-095 | pages/api/billing/flows/purchase.ts:37-68 |
| A H50 | K-096, K-269 | pages/api/billing/paystack/mandate/verify.ts:73-89   pages/api/webhooks/paystack.ts:255-269 |
| A H51 | K-042 | pages/api/invitations/index.ts:47-51 |
| A H52 | K-101 | pages/api/portal/invoice/generate.ts:32-42   pages/api/portal/invoice/[token].ts:173-183   pages/api/portal/payment-link.ts:59-68 |
| A H53 | K-097, K-098 | modules/admin/services/auditService.ts:78-88,39-50 |
| A H54 | K-099 | src/lib/auth/withPlatformAdmin.ts:150   pages/api/admin/companies/[id].ts:78-92   pages/api/admin/users/[id].ts:60-76 |
| A H55 | K-100 | pages/api/admin/companies/bulk-action.ts:61-105   pages/api/admin/job-queue/bulk-action.ts:50-95 |
| B F01 | K-001 | src/lib/auth/gotrue.ts:52 |
| B F02 | K-035 | pages/api/webhooks/paystack.ts:122 |
| B F03 | K-002 | src/lib/auth/withAuth.ts:120 |
| B F04 | K-032 | src/modules/accounting/services/reports/vatBoxBasisQuery.ts:106 |
| B F05 | K-011 | src/modules/accounting/services/ar/creditNoteCancelService.ts:145 |
| B F06 | K-014 | src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts:201 |
| B F07 | K-010 | src/modules/accounting/services/gl/journalEntryPostingService.ts:241 |
| B F08 | K-019 | src/modules/accounting/services/bank/bankTransferLinkService.ts:58 |
| B F09 | K-022 | src/modules/accounting/services/payroll/payrollLoanService.ts:529 |
| B F10 | K-023 | src/modules/accounting/services/payroll/payrollRunService.ts:143 |
| B F11 | K-039 | src/modules/accounting/services/practice/practiceClientRateOverrideService.ts:97 |
| B F12 | K-040 | src/modules/accounting/services/practice/practiceWipService.ts:259 |
| B F13 | K-096 | pages/api/webhooks/paystack.ts:255 |
| B F14 | K-196 | src/modules/accounting/services/gl/journalEntryPostingService.ts:250 |
| B F15 | K-187 | pages/api/accounting/afs/[documentId]/export.ts:115 |
| B F16 | K-188 | pages/api/accounting/afs/[documentId]/export.ts:82 |
| B F17 | K-189 | src/modules/accounting/services/afs/afsHtmlRendererService.ts:164 |
| B F18 | K-021 | src/modules/accounting/services/bank/bankAllocationService.ts:642 |
| B F19 | K-026 | pages/api/accounting/assets/below-threshold.ts:49 |
| B F20 | K-027 | src/modules/accounting/services/gl/assetDepreciationPosting.ts:137 |
| B F21 | K-028 | pages/api/accounting/assets/afs-summary.ts:55 |
| B F22 | K-029 | src/modules/accounting/services/items/depreciationRunPlan.ts:102 |
| B F23 | K-186 | pages/api/accounting/assets/[assetId]/dispose.ts:85 |
| B F24 | K-020 | src/modules/accounting/services/bank/bankReconciliationService.ts:266 |
| B F25 | K-153 | src/modules/accounting/services/bank/bankReconciliationCancelService.ts:75 |
| B F26 | K-044 | src/modules/accounting/services/core/recurringTransactionService.ts:190 |
| B F27 | K-107 | src/modules/accounting/services/core/recurringTransactionService.ts:165 |
| B F28 | K-013 | src/modules/accounting/services/ar/recurringInvoiceService.ts:131 |
| B F29 | K-085 | pages/api/accounting/stock-adjustments.ts:47 |
| B F30 | K-233 | src/modules/accounting/services/ar/salesOrderService.ts:275 |
| B F31 | K-018 | src/modules/accounting/services/bank/openBankingSyncService.ts:189 |
| B F32 | K-038 | src/modules/admin/services/sageMigrationCommitService.ts:109 |
| B F33 | K-034 | src/modules/billing/services/subscriptionBillingService.ts:50 |
| B F34 | K-204 | src/components/admin/companies/CompanyBillingTab.tsx:76 |
| B F35 | K-210 | src/modules/admin/services/sageMigrationCommitService.ts:295 |
| B F36 | K-156 | src/modules/accounting/services/capture/imapMirrorService.ts:304 |
| B F37 | K-219 | src/modules/accounting/services/core/migrationService.ts:127 |
| B F38 | K-162 | pages/api/accounting/capture/upload.ts:173 |
| B F39 | K-213 | pages/api/oauth/consent.ts:51 |
| B F40 | K-214 | src/lib/auth/oauth.ts:289 |
| B F41 | K-215 | src/lib/auth/oauth.ts:485 |
| B F42 | K-024 | pages/api/payroll/irp5/easyfile-export.ts:97 |
| B F43 | K-170 | src/modules/accounting/services/payroll/easyFileExportService.ts:244 |
| B F44 | K-229 | src/modules/accounting/services/core/timeTrackingService.ts:95 |
| B F45 | K-171 | src/modules/bureau/services/ownerCashPositionService.ts:83 |
| B F46 | K-003 | pages/api/bureau/clients.ts:64 |
| B F47 | K-025 | src/modules/accounting/services/payroll/payrollBatchService.ts:498 |
| B F48 | K-190 | src/modules/accounting/services/afs/noteGenerators/notes6to10.ts:191 |
| B F49 | K-191 | src/modules/accounting/services/afs/noteGenerators/notes6to10.ts:194 |
| B F50 | K-216 | src/lib/auth/withAuth.ts:100 |
| B F51 | K-084 | src/lib/amortisation/engine.ts:178 |
| B F52 | K-222 | src/components/accounting/CreateEntityModal.tsx:133 |
| B F53 | K-223 | pages/accounting/ap/supplier-statements/index.tsx:107 |
| B F54 | K-224 | pages/accounting/suppliers/expectations.tsx:108 |

## Detail medium/low coverage

118 explicit medium/low headings in the four preserved detail reports have K counterparts. These are source-reference locators, not invented A M/L IDs. Each mapping was checked against title/claim; corresponding paths remain available in the detail body and K record.

| Preserved detail locator | Severity | K | Heading |
|---|---|---|---|
| inputs/ar-ap-loans-items.md:281 | MEDIUM | K-172 | A period with a lump-sum loan event can never be paid |
| inputs/ar-ap-loans-items.md:290 | MEDIUM | K-179 | `capitalGain` reports zero when an asset sells above original cost |
| inputs/ar-ap-loans-items.md:301 | MEDIUM | K-130 | Supplier statement counts draft and pending-approval bills as money owed |
| inputs/ar-ap-loans-items.md:311 | MEDIUM | K-131 | Supplier statement joins the dead allocation table |
| inputs/ar-ap-loans-items.md:319 | MEDIUM | K-119 | Monthly recurring invoices drift off month-end |
| inputs/ar-ap-loans-items.md:327 | MEDIUM | K-132 | Missing Netcash keys make a payment run report success |
| inputs/ar-ap-loans-items.md:337 | MEDIUM | K-121 | `convertToSalesOrder` has no status guard |
| inputs/ar-ap-loans-items.md:346 | MEDIUM | K-122 | Dunning emails send customers a portal link that always 404s |
| inputs/ar-ap-loans-items.md:354 | MEDIUM | K-173 | Client-supplied `bankAccountId` is posted as a GL account with no company check |
| inputs/ar-ap-loans-items.md:365 | MEDIUM | K-133 | Three-way match's caught UPDATE failure aborts the whole request |
| inputs/ar-ap-loans-items.md:375 | MEDIUM | K-134 | A header-only supplier invoice cannot be approved |
| inputs/ar-ap-loans-items.md:386 | MEDIUM | K-183 | Stock adjustment returns 404 after the row is already inserted |
| inputs/ar-ap-loans-items.md:395 | MEDIUM | K-116 | Receipt application ignores allocations pending on draft payments |
| inputs/ar-ap-loans-items.md:405 | MEDIUM | K-180 | `approveAdjustment` can post the same journal twice |
| inputs/ar-ap-loans-items.md:414 | MEDIUM | K-117 | Unapplied-receipts report counts draft payments as unapplied cash |
| inputs/ar-ap-loans-items.md:422 | MEDIUM | K-118 | `noJournal` bucket swallows receipts whose journal predates the posting-agent stamp |
| inputs/ar-ap-loans-items.md:431 | MEDIUM | K-127 | Portal chatbot sanitiser mangles ordinary English replies |
| inputs/ar-ap-loans-items.md:440 | MEDIUM | K-135 | `createSupplierInvoice` does not verify the supplier belongs to the company |
| inputs/ar-ap-loans-items.md:450 | MEDIUM | K-174 | Loan financial-terms edit guard misses two common cases |
| inputs/ar-ap-loans-items.md:459 | MEDIUM | K-175 | Loan portfolio totals come from schedule period 1 |
| inputs/ar-ap-loans-items.md:467 | MEDIUM | K-176 | `closeLoanPeriod` locks the period even when every loan was skipped |
| inputs/ar-ap-loans-items.md:476 | MEDIUM | K-177 | Loan compliance reads a table `recordLoanPayment` never writes |
| inputs/ar-ap-loans-items.md:483 | MEDIUM | K-136 | `approveBatch` and `cancelBatch` report success when they change nothing |
| inputs/ar-ap-loans-items.md:493 | MEDIUM | K-232 | Bulk recurring run catches per-element errors with no savepoint |
| inputs/ar-ap-loans-items.md:502 | MEDIUM | K-120 | Recurring and sales-order invoice numbering bypasses the company sequence |
| inputs/ar-ap-loans-items.md:512 | MEDIUM | K-123 | `listDisputes` returns the page size as the total |
| inputs/ar-ap-loans-items.md:519 | MEDIUM | K-126 | Invoice PDF derives every line's VAT from a header rate conversions never set |
| inputs/ar-ap-loans-items.md:531 | MEDIUM | K-181 | Soft-deleted items are still returned by every list query |
| inputs/ar-ap-loans-items.md:539 | MEDIUM | K-125 | Debtors queries drop invoices with NULL `amount_paid` |
| inputs/ar-ap-loans-items.md:546 | MEDIUM | K-124 | Dispute credit-note creation ignores the legacy `customer_id` column |
| inputs/ar-ap-loans-items.md:554 | MEDIUM | K-182 | Items PUT with an explicit null crashes or stores the string `"null"` |
| inputs/ar-ap-loans-items.md:562 | MEDIUM | K-231 | Mileage-trip endpoint turns a post-write failure into a 400 |
| inputs/ar-ap-loans-items.md:570 | MEDIUM | K-184 | `GREATEST(0, …)` clamps stock while the movement ledger records the full quantity |
| inputs/ar-ap-loans-items.md:581 | LOW | K-253 | `getBatchById` drops the tenancy filter on an empty company id |
| inputs/ar-ap-loans-items.md:586 | LOW | K-261 | Loan `curve_id` is never ownership-checked |
| inputs/ar-ap-loans-items.md:592 | LOW | K-254 | `processBatch` marks individually cancelled payments as processed |
| inputs/ar-ap-loans-items.md:597 | LOW | K-255 | `updatePurchaseOrder` cannot clear a field, and ignores an empty items array |
| inputs/ar-ap-loans-items.md:603 | LOW | K-251 | First sales order and delivery note per company are numbered `-00000` |
| inputs/ar-ap-loans-items.md:608 | LOW | K-252 | Malformed inbound `[ref:…]` token crashes the dunning webhook |
| inputs/ar-ap-loans-items.md:613 | LOW | K-250 | Invoice header subtotal can disagree with the sum of its stored line amounts |
| inputs/ar-ap-loans-items.md:618 | LOW | K-264 | `getBundleLines` joins `items` without a tenant predicate |
| inputs/ar-ap-loans-items.md:623 | LOW | K-265 | `COUNT(*)`-derived item codes collide |
| inputs/ar-ap-loans-items.md:628 | LOW | K-267 | Expense claim numbering is COUNT-based with no retry |
| inputs/ar-ap-loans-items.md:633 | LOW | K-266 | Dry-run/live parity gap for tax-only depreciation rows |
| inputs/ar-ap-loans-items.md:639 | LOW | K-262 | `gl-postings` route does not validate the loan id |
| inputs/ar-ap-loans-items.md:644 | LOW | K-263 | Doc drift on the loan schedule hash |
| inputs/gl-core.md:131 | MEDIUM | K-107 | Recurring invoice numbers are constant for a whole month |
| inputs/gl-core.md:138 | MEDIUM | K-218 | Sage import invents 15% VAT when the source subtotal is absent |
| inputs/gl-core.md:145 | MEDIUM | K-108 | Approval rules accept any operator string and then never match |
| inputs/gl-core.md:152 | MEDIUM | K-109 | Approval requests accept a cross-tenant rule id, and the rule join is unscoped |
| inputs/gl-core.md:159 | MEDIUM | K-110 | Deleting a GL cost centre silently unassigns every employee |
| inputs/gl-core.md:166 | MEDIUM | K-111 | Duplicate merge and time-entry actions always report zero rows changed |
| inputs/gl-core.md:173 | MEDIUM | K-229 | Time-entry listing ignores every filter it is passed |
| inputs/gl-core.md:180 | MEDIUM | K-112 | Opening-balance-equity race recovery is dead code inside a request transaction |
| inputs/gl-core.md:187 | MEDIUM | K-113 | Re-running year-end close reports a false zero and then 500s |
| inputs/gl-core.md:194 | MEDIUM | K-226 | Fire-and-forget email log insert can abort the caller's transaction |
| inputs/gl-core.md:201 | MEDIUM | K-114 | Import preview reports balance over only the valid rows |
| inputs/gl-core.md:208 | MEDIUM | K-115 | Two integrity-check totals are wrong |
| inputs/gl-core.md:215 | LOW | K-235 | Auto-generated journals are dated by UTC, not South African time |
| inputs/gl-core.md:222 | LOW | K-236 | Recurring-journal advance UPDATE is not company-scoped |
| inputs/gl-core.md:228 | LOW | K-237 | Non-UUID user ids are resolved to an arbitrary user across all tenants |
| inputs/gl-core.md:235 | LOW | K-248 | Enabling online payment on a settled invoice creates a live R0.00 link |
| inputs/gl-core.md:242 | LOW | K-238 | `suggestNextAccountCode` can raise 22P02 on charts with non-numeric account codes |
| inputs/gl-core.md:249 | LOW | K-239 | Re-seeding a chart from a template can null out existing parent links |
| inputs/gl-core.md:256 | LOW | K-240 | `getAccountBalance` reads cached balances with no company predicate |
| inputs/gl-core.md:263 | LOW | K-241 | `deleteAccount` only blocks on active children |
| inputs/gl-core.md:270 | LOW | K-242 | `closeYear` bulk-closes a fiscal year with none of the readiness checks |
| inputs/gl-core.md:277 | LOW | K-243 | Payroll cost-centre summary double-counts split employees |
| inputs/gl-core.md:284 | LOW | K-249 | EMP201 declares uncapped gross as the UIF and SDL remuneration |
| inputs/gl-core.md:291 | LOW | K-244 | Learning fallback can mint a cross-tenant global categorisation pattern |
| inputs/gl-core.md:298 | LOW | K-245 | Pattern-usage UPDATE is fired without await inside the request transaction |
| inputs/gl-core.md:305 | LOW | K-246 | Invitation paths cast a TEXT user id to UUID |
| inputs/gl-core.md:312 | LOW | K-247 | FX gain/loss sign is inverted for foreign-currency assets |
| inputs/bank-reconciliation-capture.md:98 | MEDIUM | K-140 | Auto-post gate sweep has no savepoint, so one failed row makes every later row report a bogus skip reason |
| inputs/bank-reconciliation-capture.md:105 | MEDIUM | K-141 | Rule `match_pattern` is concatenated into ILIKE unescaped, and `exact` is not exact |
| inputs/bank-reconciliation-capture.md:112 | MEDIUM | K-142 | Supplier-invoice match candidates score the gross total and ignore what is already paid |
| inputs/bank-reconciliation-capture.md:119 | MEDIUM | K-143 | Auto-post undo counts reversals that reversed nothing, and a failed reversal still marks the run undone |
| inputs/bank-reconciliation-capture.md:126 | MEDIUM | K-144 | `matchTransaction` stamps an unvalidated journal line id |
| inputs/bank-reconciliation-capture.md:133 | MEDIUM | K-019 | `relinkTransferCounterparts` can bind one journal line to two bank transactions |
| inputs/bank-reconciliation-capture.md:140 | MEDIUM | K-145 | OFX, QIF and MT940 imports bypass the empty-parse guard and report a clean import of zero rows |
| inputs/bank-reconciliation-capture.md:147 | MEDIUM | K-146 | `bulkAcceptTransactions` reports every id as accepted even when nothing was updated |
| inputs/bank-reconciliation-capture.md:154 | MEDIUM | K-147 | The legacy Stitch feed service joins the vestigial `bank_accounts` table, so listing, syncing and disconnecting all fail silently |
| inputs/bank-reconciliation-capture.md:161 | MEDIUM | K-154 | Statement reconciliation lets one ledger invoice match many statement lines |
| inputs/bank-reconciliation-capture.md:168 | MEDIUM | K-155 | Capture duplicate detection ignores invoice status, so a cancelled invoice permanently blocks re-capture |
| inputs/bank-reconciliation-capture.md:175 | MEDIUM | K-156 | IMAP scan cursor advances past messages whose ingest failed |
| inputs/bank-reconciliation-capture.md:182 | MEDIUM | K-157 | `attachEvidenceToProvisional` swallows SQL errors inside the caller's transaction |
| inputs/bank-reconciliation-capture.md:189 | MEDIUM | K-158 | A VAT registration number is written into the `vat_code` column and becomes the supplier's default |
| inputs/bank-reconciliation-capture.md:196 | MEDIUM | K-159 | WhatsApp amount parser glues space-separated digit groups |
| inputs/bank-reconciliation-capture.md:203 | MEDIUM | K-160 | Twilio webhook retries re-ingest the same document |
| inputs/bank-reconciliation-capture.md:210 | MEDIUM | K-148 | OCR statement commit counts conflicting rows as imported |
| inputs/bank-reconciliation-capture.md:217 | MEDIUM | K-149 | Allocation silently skips the bank_transactions write when the bank journal line cannot be found |
| inputs/bank-reconciliation-capture.md:224 | LOW | K-257 | Multi-doc match reports a matched cross-reference when the value is simply missing |
| inputs/bank-reconciliation-capture.md:230 | LOW | K-258 | Feed duplicate lookups are not scoped by `company_id` |
| inputs/bank-reconciliation-capture.md:236 | LOW | K-259 | `createAndSendQuery` sends the WhatsApp message before persisting the query row |
| inputs/api-admin-auth-billing-portal.md:119 | MEDIUM | K-201 | Invoice payment can be double-credited inside a one-second window |
| inputs/api-admin-auth-billing-portal.md:125 | MEDIUM | K-104 | Two invitation systems write incompatible token encodings into one column |
| inputs/api-admin-auth-billing-portal.md:131 | MEDIUM | K-105 | Invitation lookup leaks the full invitee email and ignores expiry/acceptance |
| inputs/api-admin-auth-billing-portal.md:137 | MEDIUM | K-212 | One OAuth authorisation row per (app, user, company) kicks the previous device off |
| inputs/api-admin-auth-billing-portal.md:143 | MEDIUM | K-202 | mandate/verify has no role gate while create/revoke require admin |
| inputs/api-admin-auth-billing-portal.md:150 | MEDIUM | K-197 | generateDueCharges can permanently strand a subscription unbilled |
| inputs/api-admin-auth-billing-portal.md:156 | MEDIUM | K-198 | Retried subscription charges reuse the same Paystack reference and can never succeed |
| inputs/api-admin-auth-billing-portal.md:162 | MEDIUM | K-199 | A non-active mandate burns all three charge attempts |
| inputs/api-admin-auth-billing-portal.md:169 | MEDIUM | K-200 | triggerAutoTopup credits a bundle with no payment taken (latent) |
| inputs/api-admin-auth-billing-portal.md:174 | MEDIUM | K-106 | Invitation 502 path tells the user to resend an invitation that was rolled back |
| inputs/api-admin-auth-billing-portal.md:180 | MEDIUM | K-205 | Web-analytics CSV export skips the CSV-injection neutraliser every other export uses |
| inputs/api-admin-auth-billing-portal.md:187 | MEDIUM | K-206 | PAYG admin list sorts the wrong companies to the top |
| inputs/api-admin-auth-billing-portal.md:192 | MEDIUM | K-207 | Admin MRR figures disagree across screens |
| inputs/api-admin-auth-billing-portal.md:198 | MEDIUM | K-208 | Company list/export duplicate companies holding more than one active/trial subscription |
| inputs/api-admin-auth-billing-portal.md:203 | MEDIUM | K-209 | Impersonation cookies are set before the transaction carrying the audit row commits |
| inputs/api-admin-auth-billing-portal.md:209 | MEDIUM | K-203 | recalculateNudge fires after the response on a connection about to be committed and released |
| inputs/api-admin-auth-billing-portal.md:217 | LOW | K-269 | Paystack authorisation capture updates every mandate for the company |
| inputs/api-admin-auth-billing-portal.md:222 | LOW | K-276 | Portal token mint and payment-link creation lack CSRF |
| inputs/api-admin-auth-billing-portal.md:227 | LOW | K-277 | Refresh tokens minted regardless of offline_access |
| inputs/api-admin-auth-billing-portal.md:232 | LOW | K-270 | Successful Flow refunds are logged as failures after the response is sent |
| inputs/api-admin-auth-billing-portal.md:238 | LOW | K-273 | Streamed CSV exports page with OFFSET over a non-unique sort key |
| inputs/api-admin-auth-billing-portal.md:243 | LOW | K-274 | Admin webhook mutation routes skip withCsrf |
| inputs/api-admin-auth-billing-portal.md:248 | LOW | K-275 | Unvalidated companyId in PAYG admin routes returns 500 instead of 400 |
| inputs/api-admin-auth-billing-portal.md:253 | LOW | K-280 | onboarding/documents stores client-supplied file_size |

## Open scope gaps and ambiguities

- **Latent AP-import claim absent as its own K candidate:** inputs/ar-ap-loans-items.md:651–658 states migrationApService.ts:92–99 posts full expense/VAT/AP while recording already-paid amounts without settlement journals, and unbalanced source subtotal/tax/total can fail posting. K-015 covers the missing-column blocker; K-038 covers Sage import discarding source payment balances, a different service/trigger. This latent claim is not aliased to either: it is now tracked separately as R-001 and R-002, both dependent on K-015. Explicit reproduction after the schema blocker clears remains pending. No new K ID was invented here.
- **Compound route row:** A low list at inputs/2026-09-08-claude-full-code-audit.html:224 maps to K-281 but contains six independently testable subclaims: cash-flow export rate limit; bank-import-batches error masking; approval-rules DELETE array guard; batch-payments id array guard; batch-payments NaN limit; loans route UUID inconsistency. K-281's register entry now lists all six required checks with source paths, and each has been verified present in current code at ebeac9ca. The loans-UUID subset shares the same root cause as K-262: both are the missing UUID validation on `loanId` in `gl-postings.ts` (K-281 tracks the cross-route inconsistency, K-262 is the single-route instance) — see the `notes` field on both items.
- **Supplier-category low row is covered:** A HTML:221 supplier-categories.ts PUT/DELETE rowcount behavior maps to K-256 by affected path, despite the generic K title.
- **Aggregate counts do not prove completeness:** A headline reports 21 critical, 64 high, 110 medium and 52 low (247 total), but only 21 critical and 55 high are explicitly numbered. Nine headline high findings have no explicit numbered identity. The first medium table contains 30 rows, and details contain 79 medium headings, totaling 109 rather than headline 110. Low lists group multiple defects; their bullet count is not a finding count. Retain the discrepancy instead of inventing nine H IDs or one M ID.
- **Grouped late-area summaries omit headings present in details:** all 118 detail medium/low headings are now linked above. Examples omitted from compressed prose include gl-core deleteAccount inactive-child handling (K-241), admin invitation 502 rollback advice (K-106), and numerous AR/AP items after the first ten medium titles. These are covered by K rows; the summary prose is not exhaustive.
- **Auditor coverage gaps remain explicit:** A HTML:245–251 did not reach about 20 pages/api/payroll routes and pages/payroll UI, payrollEmployeeHistoryService, VAT201 UI components, or JournalEntriesTab. ar-ap-loans-items.md:680–687 excluded the pure amortisation engine and reported no active callers for inventoryService FIFO/weighted-average and assetService depreciation. These are audit-coverage boundaries, not clean results or newly proven remediation bugs. Cross-checked against the other preserved inputs (`coverageGaps` in backlog.json): Audit B exercised 2 of the ~20 unreached payroll routes (F42/K-024, F43/K-170, framed by comparison-payroll.md as added coverage) and executed the amortisation engine's EXTEND_TERM skip-loop path (F51/K-084) — the remaining payroll routes/UI, payrollEmployeeHistoryService, VAT201 UI components, JournalEntriesTab, the amortisation engine's PMT/zero-rate/day-count/final-instalment behavior, and FIFO/weighted-average are uncovered by every preserved audit. Audit B's F22 evidence text cites "assetService lines 167 and 177" as read by a live run path, which appears to contradict Audit A's "no call sites anywhere" claim for the assetService depreciation engine; this contradiction is retained unresolved, not merged into a new finding.
- **Corrections remain workflow obligations:** H10/K-094 requires reviewed reproduction evidence before final false-positive disposition; C21/K-037 remains schema-dependent; H2/K-080 needs official effective-dated SARS verification. H36/C4 must be tested with migration 501 present. No report agreement replaces current-code reproduction.

## Supplemental retention

The two latent AP-import claims above are now separately retained as R-001 and R-002, dependent on K-015. These supplemental IDs do not replace or renumber any original K ID. K-281 now lists all six required checks in the register. Source aggregate discrepancies remain visible.

## Scope completion (2026-09-09)

- **Unnumbered-row locators:** all 39 target rows (K-128, K-129, K-137–139, K-150–152, K-161, K-163–169, K-178, K-185, K-192–195, K-211, K-217, K-220–221, K-225, K-227–228, K-230, K-234, K-256, K-260, K-268, K-271–272, K-278–279, K-281) got a `sourceReferences` locator into `inputs/2026-09-08-claude-full-code-audit.html` (all 39 grep-verified line numbers; the underlying claim text for every row was located and matched verbatim). No `sourceGap` was needed for any of the 39.
- **Compound-claim reconciliation:** K-281's six `requiredChecks` entries each got a `path`; every one was re-verified by reading the named file at `ebeac9ca` (current code, later than the register's `auditedSha` 5661d6f0). K-262 and K-281's sixth subcheck (loans UUID inconsistency) were determined to be the **same root cause** — both are the missing `UUID_RE`/`isValidUUID` check on `loanId` in `gl-postings.ts:21` — recorded in both items' `notes`. K-138 got a 3-entry `requiredChecks` array (supplier-returns.ts, supplier-activities.ts, supplier-contacts.ts), each re-verified against `ebeac9ca`.
- **Aggregate counts:** a `sourceDiscrepancies` array (3 entries) was added to backlog.json covering the 9 unnumbered headline-high count, the 109-vs-110 medium count, and the low-bullet-count-is-not-a-finding-count issue, each dispositioned "retained-unresolvable: no additional finding invented".
- **Coverage limitations:** a `coverageGaps` array (7 entries) was added to backlog.json. Two gaps turned out to be partially covered by Audit B (2 of ~20 payroll routes via F42/K-024 and F43/K-170; the amortisation engine's EXTEND_TERM skip-loop via F51/K-084); one gap (assetService depreciation) surfaced an unresolved contradiction between Audit A ("no call sites anywhere") and Audit B's F22 evidence text; the remaining four gaps (payrollEmployeeHistoryService, VAT201 UI components, JournalEntriesTab, FIFO/weighted-average, and most of the amortisation engine's named behaviors) are uncovered by every preserved audit.
- **Stale wording fixed:** the two "Open scope gaps" bullets that spoke of R-001/R-002 and K-281's six checks as future work were rewritten to reflect that they are imported/populated; validation of K-281's checks against current code is recorded as done, not merely pending.
- **Validation:** `backlog.json` still parses, still has exactly 285 items with unique ids, and no pre-existing field was removed (spot-checked against K-001). `python3 docs/audits/remediation/render.py` was run and regenerated `index.html` without error.
