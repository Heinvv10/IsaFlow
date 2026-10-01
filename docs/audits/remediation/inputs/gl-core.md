## Findings for `services/gl/` + `services/core/`

Five parallel auditors covered the 173 files; the journal posting core was read directly, and the schema-level claims below were independently re-verified (`balance_due` absent from every migration, `debit >= 0` CHECK at `200_accounting_foundation.sql:86`, `verifyEntityOwnership`, `decideRequest`, `buildPreview`).

### [CRITICAL] NL-query table allowlist is bypassed by a quoted identifier
- File: `src/modules/accounting/services/core/nlQueryValidationService.ts:119` (scope guard at `nlQueryScopeGuard.ts:100`)
- Bug: The allowlist regex is `\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)`, which cannot match a double-quoted name. `FROM "webhook_endpoints"` yields zero matches, so the check loop never runs. `enforceTenantScope` never consults the allowlist for FROM entries at all; it only requires a `company_id = '<caller>'` predicate, which a single-table select satisfies trivially. Any table carrying a `company_id` column becomes readable.
- Trigger: A user with write access asks a question that steers the model to emit `SELECT w.url, w.secret FROM "webhook_endpoints" w WHERE w.company_id = '<own id>'`. It passes both guards and executes, returning webhook signing secrets. Same for `"company_invitations"` invite token hashes and expiry.
- Confidence: HIGH. Verified by running the regex and `pgsql-ast-parser` on that exact string: allowlist matches `[]`, parser returns a single aliased table, verdict `ok`.
- Evidence: `const kwPattern = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;` then `if (!ALLOWED_TABLES.has(tableName) && !cteAliases.has(tableName))`

### [CRITICAL] Migration rollback deletes pre-existing chart accounts and orphans posted lines
- File: `src/modules/accounting/services/core/migrationExecuteService.ts:224` (with `:88`)
- Bug: The chart upsert uses `ON CONFLICT (company_id, account_code) DO UPDATE SET ... imported_from = EXCLUDED.imported_from`, so an account the tenant already had gets stamped with the import source. Rollback then runs an unqualified `DELETE FROM gl_accounts WHERE company_id = ... AND imported_from = ${source}`, with no check for existing journal lines and no restriction to rows this run inserted.
- Trigger: Tenant already has account 1110 Bank. Operator imports a Xero file containing 1110, so the upsert stamps it. Operator clicks Rollback: the original account is destroyed. If opening balances were already posted, the NOT NULL FK on `gl_journal_lines.gl_account_id` raises instead and rollback is permanently broken.
- Confidence: HIGH
- Evidence: `DELETE FROM gl_accounts WHERE company_id = ${companyId}::UUID AND imported_from = ${source} RETURNING id`

### [HIGH] Approval workflow allows self-approval and ignores the approver role
- File: `src/modules/accounting/services/gl/approvalService.ts:230` (route `pages/api/accounting/approval-requests.ts:67`)
- Bug: `decideRequest` updates on nothing but id, company and pending status. It never reads the matched rule's `approver_role` and never compares the decider against the requester. The route is gated only by `withWriteAccess`, whose defaults include `manager`. The whole approval control is decorative.
- Trigger: A manager raises a R2m supplier invoice, then immediately calls the same endpoint with `action: 'approve'`. The rule requiring an admin is satisfied by the requester alone; `decided_by` equals `requested_by`.
- Confidence: HIGH. Verified directly.
- Evidence: `WHERE id = ${requestId}::UUID AND company_id = ${companyId} AND status = 'pending'` with no role or requester predicate.

### [HIGH] Recurring invoice auto-post moves the subledger but writes no GL journal
- File: `src/modules/accounting/services/core/recurringTransactionService.ts:191` and `:239`
- Bug: `executeRecurring` posts by a bare `UPDATE customer_invoices SET status = 'posted'`. The real posting path (`customerInvoiceApprovalService.ts:141`) calls `postCustomerInvoiceToGL`. The invoice enters aging and outstanding balances with nothing debited to AR or credited to revenue, and no fiscal period.
- Trigger: Any recurring customer or supplier invoice template with auto-post enabled. The subledger-to-control gap grows by the invoice total on every run.
- Confidence: HIGH
- Evidence: `const postResult = (await sql\`UPDATE customer_invoices SET status = 'posted' WHERE id = ${entityId}::UUID ...\`)`

### [HIGH] Opening-balance posting silently zeroes every negative source balance
- File: `src/modules/accounting/services/core/migrationOpeningBalanceService.ts:61`
- Bug: Both sides use `... && openingBalance > 0 ? openingBalance : 0`, so a negative balance yields a line with debit 0 and credit 0 instead of a posting on the opposite side. The totals check at `:80` sums those same zeroed values, so it cannot catch it. `autoMapAccounts` maps Xero's `DEPRECIATN` to `asset/debit` (`migrationParserService.ts:191`), and Xero exports accumulated depreciation as negative.
- Trigger: A chart with accumulated depreciation at -250,000 and a matching -250,000 credit-normal row. Both zero out, the remaining rows still net, the journal posts "successfully", and the opening balance sheet is out by R250,000 on two accounts with no error.
- Confidence: HIGH
- Evidence: `debit: isDebitNormal && acct.openingBalance > 0 ? acct.openingBalance : 0,`

### [HIGH] Sage supplier-invoice import has no idempotency guard and no unique index
- File: `src/modules/accounting/services/core/sageImportService.ts:365`
- Bug: `importSupplierInvoices` inserts unconditionally, guarded only by `migration_status = 'pending'`. `resetMigration(companyId,'invoices')` (`sageMigrationCompareService.ts:82`) returns rows to pending without deleting the invoices already created, and there is no unique index on `supplier_invoices(company_id, invoice_number)`. The AR twin is accidentally protected by `uq_customer_invoices_company_number`; AP is not. The ledger importer has an explicit reference plus date guard for exactly this reason.
- Trigger: import, reset, re-import. AP liability, supplier aging and the AP control account all double.
- Confidence: HIGH
- Evidence: `INSERT INTO supplier_invoices ( company_id, invoice_number, supplier_id, ...` with no prior existence check.

### [HIGH] OCR amount parsing strips the comma decimal separator, inflating amounts 100x
- File: `src/modules/accounting/services/core/ocrExtractionService.ts:146`
- Bug: `str.replace(/[\s,]/g, '')` removes the space thousands separator and the comma decimal separator alike, while the capture regexes deliberately allow both inside the number. The standard SARS/South African presentation is misread.
- Trigger: An invoice printed as `Total: R1 234,56` is cleaned to `123456` and parsed as R123,456.00, which flows into the captured document and any bill created from it.
- Confidence: HIGH
- Evidence: `const cleaned = str.replace(/[\s,]/g, ''); const num = parseFloat(cleaned);`

### [HIGH] OCR total and VAT regexes match anywhere in the document
- File: `src/modules/accounting/services/core/ocrExtractionService.ts:156`
- Bug: The total pattern has no left word boundary and `String.match` takes the first hit anywhere, so `Subtotal: 1000.00` contains a match and the excl-VAT figure becomes the total. The VAT pattern matches a VAT registration number before it reaches the real VAT line, and the subtotal is then derived as total minus that (`:186`).
- Trigger: `Subtotal 1 000.00 / VAT 150.00 / Total 1 150.00` captures the bill R150 short. A document carrying `VAT Reg No 4123456789` above the totals captures that as the VAT amount.
- Confidence: HIGH
- Evidence: `/(?:Grand\s*)?Total\s*(?:Due|Amount|Payable)?\s*[:-]?\s*(?:ZAR|R)?\s*(\d...)/i` with no `\b` and no anchor.

### [HIGH] Two migration paths write a `balance_due` column that does not exist
- File: `src/modules/accounting/services/core/migrationImportService.ts:136`, `src/modules/accounting/services/ap/migrationApService.ts:73`; reads at `migrationValidationService.ts:92` and `:129`
- Bug: No migration in the repo creates `balance_due` on either invoice table, and the reports module documents its absence. Every AR invoice insert throws 42703, is caught per row and counted as skipped while the run reports success. The failed statement also aborts the shared `withAuth` transaction (no per-row savepoint here, unlike the Sage importer), so the loop's later queries and the final session update die with 25P02. The two validation reads sit inside a `Promise.all`, so `validateMigration` rejects entirely.
- Trigger: The AR-invoice migration import returns `{imported: 0, skipped: N}` and opening AR never migrates. Migration validate returns 500, so the operator never sees the trial-balance, system-account, orphan-invoice or subtype checks either.
- Confidence: HIGH. Verified: zero hits for `balance_due` across `scripts/migrations/sql/`.
- Evidence: `subtotal, tax_amount, total_amount, amount_paid, balance_due,`

### [HIGH] Documents cannot be attached to real supplier invoices
- File: `src/modules/accounting/services/core/documentStorageService.ts:83`
- Bug: `verifyEntityOwnership` unions `sage_supplier_invoices` (the Sage staging table) but not `supplier_invoices`, the live AP table. `supplier_invoice` is nevertheless in the valid entity types, and both the upload route (`pages/api/accounting/documents.ts:118`) and `documentQueryService.listEntityDocuments:53` gate on this function.
- Trigger: Uploading a proof of invoice against an AP bill returns entity-not-found; listing returns `entity_not_found`. AP invoices can never carry supporting documents, which also empties the AP evidence and audit trail.
- Confidence: HIGH. Verified by reading the function.
- Evidence: `SELECT 1 AS ok FROM sage_supplier_invoices WHERE id = ${entityId}::uuid AND company_id = ${companyId}` with no `supplier_invoices` branch.

### [HIGH] Year-end close crashes on any contra revenue or expense balance
- File: `src/modules/accounting/services/gl/yearEndJournalBuilder.ts:70` (with `yearEndCloseService.ts:143`)
- Bug: Balances are computed signed (`SUM(credit - debit)` for revenue, `SUM(debit - credit)` for expense) and every non-zero account is kept, negatives included. `buildPreview` writes the raw number into `debit` or `credit` with no absolute value or side swap, against columns carrying `CHECK (debit >= 0)` and `CHECK (credit >= 0)`. The insert raises 23514 and the whole close transaction rolls back. The dry run never inserts, so it reports a clean, balanced preview for a close that can never succeed.
- Trigger: A revenue account netting to a debit for the year (sales returns or discounts typed as revenue), or an expense account netting to a credit (expense recovery). Dry run says ready; live run 500s, no year-end journal, periods never locked.
- Confidence: HIGH. Verified both the builder and the CHECK constraint.
- Evidence: `debit: Number(a.balance), credit: 0` against `debit NUMERIC(15,2) DEFAULT 0 CHECK (debit >= 0)`

### [HIGH] Depreciation journals post with a NULL fiscal period
- File: `src/modules/accounting/services/gl/assetDepreciationPosting.ts:112`
- Bug: The function inserts straight into `gl_journal_entries` at `status='posted'`, bypassing `createJournalEntry` and `ensureFiscalPeriodForDate`. The column list omits `fiscal_period_id`, and also `posted_at` and `posted_by`. The module's own `gl/.claude.md` states this invariant and names this exact call site; the file split moved the code without fixing it.
- Trigger: Every depreciation sweep produces a posted `auto_depreciation` journal invisible to every period-bounded report. `documentsOutsideOpenPeriod` flags each one, and period close treats them as faults. Being a direct insert, `trg_gl_je_balanced` (BEFORE UPDATE only) never validates it either.
- Confidence: HIGH
- Evidence: `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, source, status, created_by, posting_agent)`

### [HIGH] Recurring journal generation has no idempotency, lock or due-date check
- File: `src/modules/accounting/services/gl/recurringJournalService.ts:77`
- Bug: The template is read with a plain SELECT (no `FOR UPDATE`), only its status is checked, and the journal is then created and posted unconditionally. There is no test that `next_run_date` has arrived, no unique key on template plus period, and the run-count/date advance happens afterwards in a separate `withTransaction`.
- Trigger: A double-click or two parallel requests post two identical journals for one period. Five calls in a day post five copies and advance `next_run_date` five months, so the following four months are silently skipped.
- Confidence: HIGH
- Evidence: `const je = await createJournalEntry(...); await postJournalEntry(companyId, je.id, userId);`

### [HIGH] Recurring-journal route returns 400 after the journal is already posted
- File: `pages/api/accounting/recurring-journals-action.ts:46` with `recurringJournalService.ts:88`
- Bug: The handler converts any throw into `apiResponse.badRequestFromError`. `withAuth` rolls back only on status 500 or above, so the 400 commits everything written before the throw, and the generator writes the journal at `:88` before its follow-up steps.
- Trigger: The template's date advance fails after posting, or posting fails after creation. The user sees "Action failed" with HTTP 400, a journal stays permanently in the ledger, and the template is left un-advanced so a retry posts it a second time.
- Confidence: HIGH
- Evidence: `return apiResponse.badRequestFromError(res, err, 'Action failed');`

### [HIGH] Sage importers run recovery SQL on a transaction the failed row already aborted
- File: `src/modules/accounting/services/core/sageCustomerImportService.ts:121`, `sageImportService.ts:475`
- Bug: Both loops run inside the single `withAuth` request transaction with no savepoints. When a row insert fails (23505 on a duplicate invoice number, or a bad client uuid), the connection is aborted. The catch then issues `UPDATE ... SET migration_status='failed'`, which raises 25P02, and the outer catch calls `failRun`, which does the same, then rethrows.
- Trigger: A re-import after a reset hits the first duplicate invoice number. The entire run 500s with an opaque "current transaction is aborted", every earlier successful row rolls back, and the run row is never marked failed.
- Confidence: HIGH
- Evidence: `} catch (err) { ... await sql\`UPDATE sage_customer_invoices SET migration_status = 'failed' ...\`; failed++; }`

### [HIGH] AR and AP close-readiness compare a current subledger balance to an as-at GL balance
- File: `src/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck.ts:33`, `apSubLedgerCheck.ts:35`
- Bug: The GL side is correctly point-in-time (`je.entry_date <= endDate`). The subledger side is not: it filters on the invoice's current status and sums the current outstanding, so payments and status changes after the period end are subtracted while the GL side still carries the receivable or payable. The comments claim "as of period end", which is false.
- Trigger: Closing January in March. A January invoice for R50,000 paid in February is now `paid`, so it drops out of the subledger sum entirely while the GL at 31 January still includes it. The difference exceeds the failure threshold, and `isBlocker` (`fiscalPeriodCloseService.ts:89`) treats a fail as a blocker, so the unattended close path throws and refuses a valid close permanently. On the UI path it reports a false "AR does not tie" on every historical period.
- Confidence: HIGH
- Evidence: `SUM(ci.total_amount - COALESCE(ci.amount_paid, 0)) ... AND ci.status IN (...) AND ci.invoice_date <= ${period.endDate}` against `SUM(jl.debit - jl.credit) ... AND je.entry_date <= ${period.endDate}::date`

### [HIGH] Account merge into a level 1 or 2 target removes the balance from the balance sheet
- File: `src/modules/accounting/services/gl/accountMergeGuards.ts:154`, with reparenting at `accountMergeService.ts:168`
- Bug: `assertMergeable` checks account type, reporting class, system flag, cycles, bank references and configuration FKs, but never the target's level or whether it will gain children. `balanceSheetService.ts:122` includes an account only when `ga.level >= 3 OR NOT EXISTS (child)`. The merge moves every source line onto the target and reparents the source's direct children onto it, so a level 1 or 2 target that gains a child becomes a header and its whole balance, now including everything just moved, vanishes. `accountParentRules.assertParentUsable` exists to refuse this and is enforced by create and reclassify; the merge path bypasses it.
- Trigger: A level-3 source holding R5m with one child merged into a level-2 target with posted lines. After the merge the target has a child, so the balance sheet excludes it and R5m disappears from assets or liabilities. The preview reports the trial balance unchanged and the identity holding, both correct and both blind to this, since the trial balance applies no header filter.
- Confidence: HIGH
- Evidence: `UPDATE gl_accounts SET parent_account_id = ${targetId}::UUID ... WHERE parent_account_id = ${sourceId}::UUID`

### [HIGH] Reclassification can post onto a parent header account
- File: `src/modules/accounting/services/gl/reclassification/planGuards.ts:84`
- Bug: `admitReclassification` checks ownership, active flag, the posting-date period, VAT control subtypes and VAT period locks, but never that the target is a leaf. `journalEntryPostingService` has no leaf check either (only `assertNoInactiveAccountLines` at `:117`), and `leafAccountValidator.validateLeafAccount:52`, written for exactly this rule, is called from neither path.
- Trigger: A batch reclassification targeting a level-2 header with children. Every journal posts and balances; the contra removes the amount from an account the balance sheet shows, and the target leg lands on one it filters out. Total assets fall by the reclassified amount with no error and a clean trial balance. `impact.ts` computes its before/after through `aggregateFigures`, which applies no header filter, so the preview shows the move as neutral.
- Confidence: HIGH
- Evidence: `leafAccountValidator.ts:52` is unreferenced by `planGuards.ts` and `journalEntryPostingService.ts`.

### [MEDIUM] Recurring invoice numbers are constant for a whole month
- File: `src/modules/accounting/services/core/recurringTransactionService.ts:166` and `:199`
- Bug: The generated number is `RINV-<name slug>-<YYYYMM>`, constant for the month. On the AR side `uq_customer_invoices_company_number` rejects the second run with 23505; on the AP side, where no such index exists, it creates a genuine duplicate bill.
- Trigger: A daily or weekly customer template succeeds on day one and 500s from day two. A daily supplier template silently creates thirty identical bills a month.
- Confidence: HIGH
- Evidence: `const invoiceNumberCI = \`RINV-${slugCI}-${periodCI}\`;`

### [MEDIUM] Sage import invents 15% VAT when the source subtotal is absent
- File: `src/modules/accounting/services/core/sageImportService.ts:382`, `sageCustomerImportService.ts:53`
- Bug: `Number(inv.subtotal || 0) || totalAmount / 1.15` replaces a null or zero subtotal with an assumed VAT-inclusive gross-up, and the tax amount becomes the derived difference. Nothing checks whether the document actually carried VAT.
- Trigger: A zero-rated or exempt R1,000 Sage bill with a null subtotal imports as subtotal R869.57 plus tax R130.43 at rate 15, an input-VAT claim the document does not support, feeding VAT201.
- Confidence: HIGH on the code, MEDIUM on how often the source subtotal is null.
- Evidence: `const taxAmount = Number(inv.tax_amount || 0) || totalAmount - subtotal;`

### [MEDIUM] Approval rules accept any operator string and then never match
- File: `src/modules/accounting/services/gl/approvalService.ts:147`, create at `:62`
- Bug: Create and update write `condition_operator` verbatim from the request body with no whitelist (`pages/api/accounting/approval-rules.ts:25` passes it straight through). The evaluating switch handles only `any`, `greater_than` and `greater_equal`, and has no default, so anything else leaves the rule unmatched with no log and no error, returning `requiresApproval: false`.
- Trigger: A rule created with operator `gt`, `>` or `less_than` appears in the UI, looks active, and never once requires approval for any document.
- Confidence: HIGH
- Evidence: `switch (r.conditionOperator) { case 'any': ... case 'greater_than': ... case 'greater_equal': ... }` with no default.

### [MEDIUM] Approval requests accept a cross-tenant rule id, and the rule join is unscoped
- File: `src/modules/accounting/services/gl/approvalService.ts:178` and `:202`
- Bug: `requestApproval` inserts `${input.ruleId}::UUID` with no check that the rule belongs to the company, and the foreign key is global. `listRequests` and `checkApproval` then join `LEFT JOIN approval_rules rl ON rl.id = ar.rule_id` with no company predicate, so the other tenant's rule name is returned as `ruleName`.
- Trigger: Company A posts a request naming Company B's rule uuid. The insert succeeds, and Company A's requests list renders Company B's rule name.
- Confidence: HIGH. Verified the join directly.
- Evidence: `INSERT INTO approval_requests (company_id, rule_id, ...) VALUES (${companyId}, ${input.ruleId}::UUID, ...)` and `LEFT JOIN approval_rules rl ON rl.id = ar.rule_id`

### [MEDIUM] Deleting a GL cost centre silently unassigns every employee
- File: `src/modules/accounting/services/core/costCentreService.ts:82`
- Bug: `deleteCostCentre` guards only on `gl_journal_lines` (`cost_center_id`, `cc1_id`, `cc2_id`). `payroll_employees.cost_centre_id` references the same table with `ON DELETE SET NULL` (`450_cost_centres.sql:55`), so the delete succeeds and every employee assigned to that centre is quietly unassigned. `payroll_employee_cost_allocations` is RESTRICT, so only tenants on the single-FK path are exposed, which is the default path migration 450 backfilled.
- Trigger: Deleting a cost centre used only by payroll. `costCentreSummaryForRun` then reports that payroll cost under the unallocated bucket with no record of what it was.
- Confidence: HIGH
- Evidence: usage check is `FROM gl_journal_lines jl WHERE (jl.cost_center_id = ... OR jl.cc1_id = ... OR jl.cc2_id = ...)` only.

### [MEDIUM] Duplicate merge and time-entry actions always report zero rows changed
- File: `src/modules/accounting/services/core/duplicateMergeService.ts:13`, `timeTrackingService.ts:209`
- Bug: Both cast the result of an `UPDATE` without `RETURNING` to something carrying `rowCount`, but the `sql` tag returns `res.rows` (`src/lib/neon.ts:99`), which is an empty array for such a statement. The reported count is therefore always zero. The writes themselves succeed; only the feedback is wrong, and it is the only feedback the operator gets.
- Trigger: Merging two customers with 40 invoices returns `reassigned: 0` and the UI shows "0 transactions reassigned", reading as a failed merge the operator may retry or reverse. Submitting timesheets returns count 0 for rows that were submitted.
- Confidence: HIGH
- Evidence: `type SqlResult = { rowCount?: number };` then `count += Number(r1.rowCount ?? 0);`

### [MEDIUM] Time-entry listing ignores every filter it is passed
- File: `src/modules/accounting/services/core/timeTrackingService.ts:77`
- Bug: The filter object is destructured only for limit and offset. `userId`, `customerId`, `projectName`, `status`, `billable`, `dateFrom` and `dateTo` are never used in either the count or the row query, while `pages/api/accounting/time-entries.ts:35` passes all of them from the query string.
- Trigger: Requesting one user's entries from a start date returns every time entry in the company for all users and all dates, with a company-wide total.
- Confidence: HIGH
- Evidence: `WHERE te.company_id = ${companyId}::UUID ORDER BY te.entry_date DESC ... LIMIT ${lim} OFFSET ${off}`

### [MEDIUM] Opening-balance-equity race recovery is dead code inside a request transaction
- File: `src/modules/accounting/services/gl/openingBalanceEquityService.ts:110`
- Bug: The `INSERT INTO gl_accounts` runs with the plain `sql` tag on the shared request connection with no savepoint. Its catch handles 23505 by re-querying, but the transaction is already aborted, so the recovery select fails with 25P02 and that error is thrown instead. The sibling `fiscalPeriodAutoCreate.ts:122` gets this right only because its inserts go through `withTransaction`.
- Trigger: Two concurrent first-time opening-balance posts for one company. Both see no OBE account, both pick code 3300, and the loser 500s instead of returning the winner's account, so the posting is lost.
- Confidence: HIGH on the mechanism, MEDIUM on frequency since it is a first-use race.
- Evidence: `} catch (err) { if ((err as {code?:unknown}).code === '23505') { const raced = await findExisting(companyId); ...`

### [MEDIUM] Re-running year-end close reports a false zero and then 500s
- File: `src/modules/accounting/services/gl/yearEndCloseService.ts:99`
- Bug: There is no guard for a year already closed. After the first close every period is locked, so the `status = 'open'` check at `:101` still passes. The first closing journal zeroed every P&L account in range, so both aggregates return nothing, net income is zero, and the preview is a single retained-earnings line of zero. The live call then collides with `uq_gl_je_company_entry_number` on the fixed entry number `YE-<year>`.
- Trigger: Any second close call for the same year, such as an MCP retry after a timeout. The dry run says ready at R0.00; the live call throws a raw 23505 and 500s. No double post occurs, but only because of that index.
- Confidence: HIGH
- Evidence: `entryNumber: \`YE-${yearLabel}\`` (`yearEndJournalBuilder.ts:87`) with no existence check before posting.

### [MEDIUM] Fire-and-forget email log insert can abort the caller's transaction
- File: `src/modules/accounting/services/core/emailService.ts:35`
- Bug: An un-awaited `INSERT INTO email_log` with a bare `.catch()` and no savepoint runs on the AsyncLocalStorage connection when a request transaction is in flight. A failure aborts the shared transaction while the catch hides the cause, so the next statement dies with an opaque 25P02. `email_log.sent_by` references `users` (`312_email_log.sql`), so any id that is not a user row triggers a 23503 here.
- Trigger: Sending an invoice with a `sentBy` that is not in `users` (a system or agent context). The log insert violates the key, is swallowed, and `emailNotificationService.ts:97`'s `UPDATE customer_invoices SET email_sent_at = NOW()` immediately after 500s on a request whose email was already delivered.
- Confidence: MEDIUM. The failure path is verified; it needs a caller supplying a non-user id.
- Evidence: `` sql`INSERT INTO email_log ...`.catch((err: unknown) => { log.error(...) }); `` inside a function returning void.

### [MEDIUM] Import preview reports balance over only the valid rows
- File: `src/modules/accounting/services/gl/glImportService.ts:156`
- Bug: `totalDebit` and `totalCredit` accumulate inside the `if (valid)` branch, so any row with an error is excluded from the sums, and `isBalanced` is a statement about a subset of the file. That summary is what the wizard shows before the user commits.
- Trigger: A three-row file of DR 1000, CR 1000 and a third row crediting 500 with a misspelt account code. The third row is excluded, so the preview shows balanced with a credit total of 1000. The execute path re-validates per group, so this is a misleading preview rather than a bad post.
- Confidence: HIGH
- Evidence: `if (valid) { validCount++; totalDebit += debit; totalCredit += credit; } else { errorCount++; }`

### [MEDIUM] Two integrity-check totals are wrong
- File: `src/modules/accounting/services/gl/integrityChecks/accountChecks.ts:57`, `vatChecks.ts:32`
- Bug: `deactivated_accounts_with_balance` sums signed amounts over a deliberately mixed-sign set (`ABS(b.balance) > 0.005` across account types) instead of absolutes, so opposing balances cancel; the sibling `clearingAccountsNotNil` at `:129` uses `SUM(ABS(f.amount))` for the same shape. Separately, `vat_displayed_differs_from_posted` joins `gl_journal_lines vl` once per VAT line on the matched journal, so both the transaction count and the tax total are multiplied by the number of VAT lines.
- Trigger: A deactivated asset at +500,000 and a deactivated loan at -500,000 report two failures worth R0.00, so a reader deprioritises exactly the class of defect the check exists to catch. A bank transaction split across two expense accounts, each with a R150 VAT leg, reports two transactions and R300 at stake for one transaction.
- Confidence: HIGH on the account check, MEDIUM on the VAT one.
- Evidence: `COALESCE(SUM(f.amount), 0) AS amount` versus `SUM(ABS(f.amount))` at line 129.

### [LOW] Auto-generated journals are dated by UTC, not South African time
- File: `src/modules/accounting/services/gl/recurringJournalService.ts:89`, `glCrossModuleHooks.ts:272` and `:275`
- Bug: `new Date().toISOString().split('T')[0]` yields the UTC date. South Africa is UTC+2, so between midnight and 02:00 local this stamps the previous calendar day. The rest of the module deliberately uses `fmtDate` for this reason (`assetDepreciationPosting.ts:89`).
- Trigger: A recurring journal generated at 00:30 on 1 September is stamped 31 August, the prior month, and potentially a closed fiscal period or a different VAT period. Same for the capitalisation-expense hook and its reference string.
- Confidence: HIGH
- Evidence: `entryDate: new Date().toISOString().split('T')[0]!`

### [LOW] Recurring-journal advance UPDATE is not company-scoped
- File: `src/modules/accounting/services/gl/recurringJournalService.ts:103`
- Bug: `UPDATE recurring_journals SET last_run_date ... WHERE id = ${id}` carries no company predicate, unlike every sibling write in the file. It is safe today only because the preceding SELECT verified ownership, a guard easy to lose in a refactor.
- Confidence: HIGH
- Evidence: `WHERE id = ${id}` versus `updateRecurringJournalStatus` at `:72`, which includes the company.

### [LOW] Non-UUID user ids are resolved to an arbitrary user across all tenants
- File: `src/modules/accounting/services/gl/journalEntryCrudService.ts:20`
- Bug: When the caller's user id is not UUID-shaped, `resolveUserUuid` runs `SELECT id FROM users WHERE id::TEXT ~ '^[0-9a-f]{8}-' LIMIT 1`, with no company scoping and no ordering, and stamps whatever heap row comes back as `created_by` and `posted_by`. Six posting paths across GL, AR and AP use it.
- Trigger: Any caller passing a non-UUID id attributes a journal to an unrelated user, possibly in another tenant. All current call sites pass a GoTrue UUID, so this is latent rather than live.
- Confidence: HIGH that the fallback behaves this way; LOW because nothing reachable triggers it today.
- Evidence: `return rows.length > 0 ? String(rows[0]!.id) : '00000000-0000-0000-0000-000000000000';`

### [LOW] Enabling online payment on a settled invoice creates a live R0.00 link
- File: `src/modules/accounting/services/core/paymentGatewayPortalService.ts:17`
- Bug: The insert-select has no balance predicate, so a settled invoice yields a row with amount zero. The thrown "Invoice not found or no balance due" is only reachable for a missing invoice.
- Trigger: Enabling online payment on a paid invoice generates a valid public `/portal/pay/<token>` link for R0.00 and writes it onto the invoice.
- Confidence: HIGH
- Evidence: `SELECT ci.id, ci.client_id, ci.total_amount - COALESCE(ci.amount_paid, 0) FROM customer_invoices ci WHERE ci.id = ... AND ci.company_id = ...`

### [LOW] `suggestNextAccountCode` can raise 22P02 on charts with non-numeric account codes
- File: `src/modules/accounting/services/gl/chartOfAccountsService.ts:222`
- Bug: The query relies on `account_code ~ '^[0-9]+$'` protecting the sibling `(account_code)::int BETWEEN ...`. Postgres does not guarantee qual evaluation order and the cast is cheaper than the regex, so the planner may apply the cast first over every row for that company and type. There is no subquery or CTE optimisation fence.
- Trigger: Velocity Fibre carries codes `SYS-7`, `SYS-8`, `SYS-9`. The next-code endpoint for that company can return a 500 instead of a code, blocking the Add Account dialog.
- Confidence: MEDIUM. The failure is plan-dependent; the unsafe construct is definite.
- Evidence: `AND account_code ~ '^[0-9]+$'` and `AND (account_code)::int BETWEEN ${range.start} AND ${range.end}` in the same WHERE.

### [LOW] Re-seeding a chart from a template can null out existing parent links
- File: `src/modules/accounting/services/gl/chartOfAccountsImportService.ts:177`
- Bug: Pass one inserts with `ON CONFLICT DO NOTHING`, leaving pre-existing accounts alone, but pass two then runs an unconditional `UPDATE ... SET parent_account_id = (SELECT id ... WHERE account_code = <parentCode>)` on every code in the template. On a company already carrying those codes with a different hierarchy the existing parent is overwritten, and if the template's parent code is absent the subquery returns NULL and the account is promoted to a root, changing which accounts the balance sheet's header filter drops.
- Trigger: Seeding the Sage-compatible template onto a company already using four-digit Sage-style codes.
- Confidence: MEDIUM
- Evidence: the update has no `WHERE parent_account_id IS NULL` guard and no null check.

### [LOW] `getAccountBalance` reads cached balances with no company predicate
- File: `src/modules/accounting/services/gl/chartOfAccountsImportService.ts:194`
- Bug: Both branches filter only on `gl_account_id` and optionally `fiscal_period_id`, with nothing scoping the tenant. It is exported and re-exported from `chartOfAccountsService.ts:477`.
- Trigger: No caller exists in `src/` or `pages/` today, so it is latent. Any future caller passing an id from a request body would read another tenant's cached balance.
- Confidence: HIGH that the scope is missing; LOW because there is no live call site.
- Evidence: `WHERE gl_account_id = ${accountId} AND fiscal_period_id = ${fiscalPeriodId}`

### [LOW] `deleteAccount` only blocks on active children
- File: `src/modules/accounting/services/gl/chartOfAccountsService.ts:403`
- Bug: The child check adds `AND is_active = true`, so an account whose children are all deactivated can itself be deactivated. Those children keep pointing at a dead parent, and reactivating one later reproduces the header problem under an inactive parent.
- Trigger: Deactivate all children of 1100, deactivate 1100, then reactivate a child. It is now a child of an inactive parent, and the tree builder re-roots it only when the parent is absent from the fetched set.
- Confidence: HIGH
- Evidence: `SELECT COUNT(*) AS cnt FROM gl_accounts WHERE parent_account_id = ${id} AND is_active = true AND company_id = ${companyId}`

### [LOW] `closeYear` bulk-closes a fiscal year with none of the readiness checks
- File: `src/modules/accounting/services/gl/fiscalPeriodService.ts:208`
- Bug: A single `UPDATE fiscal_periods SET status='closed' WHERE fiscal_year = X AND status NOT IN ('closed','locked')` bypasses `closePeriod` entirely, so no per-period guard runs and no prior fiscal year need be closed first. `closePeriod`'s own prior-period guard is scoped to the same fiscal year, so period 1 of FY2027 can close while all of FY2026 is open.
- Trigger: Calling it on a year holding unposted drafts or an unbalanced trial balance closes every period regardless, asserting the books are complete when they are not.
- Confidence: HIGH on the behaviour, LOW impact given the advisory-checks-only design elsewhere.
- Evidence: the update has no readiness call.

### [LOW] Payroll cost-centre summary double-counts split employees
- File: `src/modules/accounting/services/core/costCentreService.ts:384`
- Bug: The `line_splits` CTE emits one row per run line and allocation, and each output row's employee count is a distinct count within that centre. The run total then plain-sums those per-centre counts, so an employee split across two centres is counted twice. The money columns are correctly weighted; only headcount is not.
- Trigger: A ten-person run where three employees have two-way allocations reports 13.
- Confidence: HIGH
- Evidence: `COUNT(DISTINCT ls.employee_id)::int AS employee_count` then `employeeCount: acc.employeeCount + r.employeeCount,`

### [LOW] EMP201 declares uncapped gross as the UIF and SDL remuneration
- File: `src/modules/accounting/services/core/payrollPdfBuilders1.ts:196`
- Bug: The UIF and SDL remuneration columns and their totals print `gross_pay`. UIF remuneration is capped at R17,712 per month, so for any employee above the ceiling the return overstates declared remuneration, while the contribution column beside it is the correctly capped figure. The two columns disagree.
- Trigger: Any payroll run containing an employee above the UIF ceiling produces an EMP201 PDF with an inconsistent remuneration base.
- Confidence: MEDIUM
- Evidence: `doc.text(fmtR(gross), m + 155, y, { align: 'right' }); doc.text(fmtR(uif), m + 175, y, ...)`

### [LOW] Learning fallback can mint a cross-tenant global categorisation pattern
- File: `src/modules/accounting/services/core/smartCategorizationLearningService.ts:69`
- Bug: If the first insert fails the transaction is already aborted, so the fallback insert raises 25P02 too; the outer catch swallows it and reports "non-critical" while the caller's transaction is dead. Separately, that fallback writes a pattern row with a NULL company id holding one tenant's account id, and `smartCategorizationService.ts:69` reads `WHERE cp.company_id = X OR cp.company_id IS NULL` while joining `gl_accounts` with no company filter, exposing another tenant's account code and name as a suggestion.
- Trigger: Any constraint failure on the first insert during bank allocation.
- Confidence: MEDIUM
- Evidence: `} catch { // Fallback without company_id ... await sql\`INSERT INTO categorization_patterns (...)\`; }`

### [LOW] Pattern-usage UPDATE is fired without await inside the request transaction
- File: `src/modules/accounting/services/core/smartCategorizationMatchingService.ts:115`
- Bug: The usage-count update is issued on the AsyncLocalStorage connection but not awaited, so it can be sent after the enclosing transaction has committed or rolled back, and any error it raises poisons the still-open transaction rather than being the harmless log the catch implies.
- Trigger: Bulk categorising when a pattern row was concurrently deleted. The error lands on the shared connection mid-request and every following statement fails.
- Confidence: MEDIUM
- Evidence: `sql\`UPDATE categorization_patterns SET usage_count = usage_count + 1 ...\`.catch(...)`

### [LOW] Invitation paths cast a TEXT user id to UUID
- File: `src/modules/accounting/services/core/userInvitationService.ts:72` and `:159`
- Bug: `userAccessService.ts:69` documents that `company_users.user_id` is TEXT and `users.id` is VARCHAR, and that the parameter must never be cast to UUID. Both inserts here do exactly that, while the sibling membership select nine lines earlier correctly does not.
- Trigger: Inviting an email belonging to an existing user whose id is not UUID-shaped 500s with an invalid-syntax error instead of auto-adding, and the same on accept, leaving the invitation unaccepted.
- Confidence: MEDIUM. It depends on a non-UUID id existing; the cast is unambiguously against the documented schema.
- Evidence: `VALUES (${companyId}::UUID, ${existingUserId}::UUID, ${role})` versus `WHERE company_id = ${companyId}::UUID AND user_id = ${existingUserId}` two statements earlier.

### [LOW] FX gain/loss sign is inverted for foreign-currency assets
- File: `src/modules/accounting/services/core/multiCurrencyService.ts:137`
- Bug: Returns `(originalRate - currentRate) * originalAmount`, which is the liability form. For a foreign-currency asset the gain is the reverse, so it reports a loss where there is a gain.
- Trigger: A USD 1,000 receivable booked at 18.00 and revalued at 19.00 returns -1000 for what is a R1,000 gain.
- Confidence: MEDIUM. The function has no production callers today, only a unit test, so nothing is mis-stated now; it is a trap for the first consumer.
- Evidence: `return Math.round((originalRate - currentRate) * originalAmount * 100) / 100;`

## Checked and cleared

- `sql.transaction` does join the request transaction via a savepoint on the AsyncLocalStorage client (`src/lib/neon.ts:213`), so batched journal inserts are atomic with the handler and carry the RLS claims. No finding.
- System-account resolution by subtype is now a total order over type fit, creation time and id (`systemAccountKeys.ts:119`), and `systemRoleCoverage.classifyRole` reduces with the same function, so the previously reported heap-order defect is fixed.
- `trialBalanceService` and `trialBalanceBasis` foot: the income-statement and brought-forward ranges are exactly complementary, draft and void journals are excluded, and both range boundaries are inclusive and consistent.
- `generalLedgerStreamService` keyset pagination is sound: the four-column cursor matches the ORDER BY, the microsecond key is fixed-width so text order equals timestamp order, the empty-page recursion terminates, and the opening balance is unaffected by the limit.
- The account merge write path preserves the trial balance by construction: `repointMovableLines` is company-scoped, re-applies the exact status and period predicate from `classifySourceLines`, changes no debit or credit, and aborts the whole merge on any row-count drift.
- The reclassification lock and re-read sequence closes the double-post window, `partition.ts` skips both halves of a reversal pair, and `impact.ts` derives before and after from two independent aggregations.
- `paymentVoidService` and `paymentLock` are correct: the row lock is taken inside the request transaction, the unwind reduces `amount_paid` relatively, recomputes status, deletes allocations and cancels the document, and it precedes the journal reversal without double-reversing the bank-backed shape.
- All of `closeRun/` is sound: claim-first-inside-savepoint approve path, run-status guard, and a per-proposal status guard.
- `globalSearchService` (all seven sub-queries), `archiveExecutionService`, `archiveQueryService`, `archiveReadService`, `dataArchivingService`, `softDeleteService` and `contraSettlementService` are correctly company-scoped with correct savepoint discipline and money math.

## Files read

Directly: `src/modules/accounting/services/gl/{journalEntryPostingService,journalEntryCrudService,journalEntryService,journalEntryMeta,yearEndJournalBuilder,approvalService}.ts`, `src/modules/accounting/services/core/documentStorageService.ts`, `src/lib/neon.ts`, `scripts/migrations/sql/200_accounting_foundation.sql`.

Slice 1 (period/close/year-end): `gl/{fiscalPeriodService,fiscalPeriodCloseService,fiscalPeriodAutoCreate,fiscalYearBasis,fiscalYearCalendar,fiscalYearCreateService,periodStatusService,periodCloseReadinessService,monthEndCloseService,yearEndCloseService,yearEndJournalBuilder,yearEndService,openingBalanceEquityService,openingBalanceReadService,continuousCloseService,continuousCloseQueryService}.ts`, all of `gl/closeRun/` and `gl/closeReadinessChecks/`, plus migrations 200, 201, 220.

Slice 2 (accounts/merge/reclass): `gl/{accountClassification,accountMergeFigures,accountMergeGuards,accountMergeNotes,accountMergePreview,accountMergeRecord,accountMergeReferences,accountMergeService,accountParentRules,accountReclassifyService,accountReportingClass,accountSubtypeRules,chartOfAccountsService,chartOfAccountsImportService,chartOfAccountsHealth,chartOfAccountsHealthService,leafAccountValidator,glAccountBalance,glAccountLock,controlAccountService,systemAccountKeys,systemAccountResolver,systemRoleCoverage}.ts`, all of `gl/reclassification/`, plus `reports/balanceSheetService.ts` and `pages/api/accounting/chart-of-accounts-next-code.ts`.

Slice 3 (reporting/integrity/VAT/import): `gl/{trialBalanceService,trialBalanceBasis,generalLedgerReportService,generalLedgerStreamService,generalLedgerStreamTypes,financialFiguresService,transactionLedgerService,auditTrailLedgerService,auditTrailAttribution,glIntegrityService,inputVatDenial,nonSupplyAccounts,nonSupplyVatGuard,ruleVatResolution,glImportService,glImportExecuteService,glCrossModuleHooks,assetDepreciationPosting,recurringJournalService,approvalService,journalEntryListService,journalEntryMeta}.ts`, all of `gl/integrityChecks/`, both `.claude.md` docs, `pages/api/accounting/{recurring-journals-action,approval-requests}.ts`, `src/lib/auth/withWriteAccess.ts`, migration 234.

Slice 4 (core a–m): `core/{globalSearchService,companyAccessService,archiveExecutionService,archiveQueryService,archiveReadService,dataArchivingService,duplicateMergeService,duplicateDetectionService,masterDeleteGuards,migrationOpeningBalanceService,migrationImportService,migrationExecuteService,migrationValidationService,migrationCoaService,migrationContactService,migrationService,migrationParserService,migrationTemplateService,migrationSubtypeCheck,contraSettlementService,currencyService,multiCurrencyService,budgetService,costCentreService,companyService,companySettingsService,companyMapper,customerWriteService,contactDirectoryService,jobQueueService,leaveService,auditTrailService,evidenceGraphService,businessUnitService,documentStorageService,documentQueryService,documentValidationService,anomalyDetectionService,descriptionTemplateService,emailService,emailNotificationService}.ts` plus `core/.claude.md`, `pages/api/accounting/documents.ts`, migrations 000, 200, 312, 450, 451. Skipped as containing no SQL and no money arithmetic: `aiCategorizationService`, `aiInvoicePipelineService`, `categorizationStrategy`, `contractExtractionService`, `docExtractionEnhancedService`, `inviteEmailService`, `migrationSubtypeMessage`, `index.ts`.

Slice 5 (core n–z): `core/{nlQueryScopeGuard,nlQueryValidationService,nlQueryService,nlQueryFkPairs,ocrService,ocrExtractionService,paymentGatewayPortalService,paymentLock,paymentVoidService,payslipVerificationService,payrollPdfBuilders1,payrollPdfBuilders2,recurringTransactionService,sageAutoImportService,sageCustomerImportService,sageImportService,sageMigrationCompareService,sageMigrationService,smartCategorizationService,smartCategorizationMatchingService,smartCategorizationLearningService,softDeleteService,supplierWriteService,timeTrackingService,udfService,userAccessService,userInvitationService,webhookService}.ts` plus `pages/api/accounting/{nl-query,time-entries,time-entries-action,sage-migration-action}.ts`, `src/lib/mcp/tools/writeVoidPayments.ts`, `services/bank/bankAllocationUnwind.ts`, migrations 220, 235, 241, 300b.
