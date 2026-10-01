# Findings for src/modules/accounting/services/{bank,reconciliation,capture}/

Commit 5661d6f0. Three sub-scopes audited in parallel; findings merged and ranked.

---

### [CRITICAL] A VAT code on a supplier/customer bank allocation relieves the control account NET while the payment document settles GROSS
- File: `src/modules/accounting/services/bank/bankAllocationService.ts:242-247, 402-413, 450-459`
- Bug: When `vatCode = 'standard'`, the supplier arm posts Dr AP `netAmount` + Dr VAT-Input `vatAmount` / Cr Bank `totalAmount`, then calls `recordSupplierBankPayment` with `amount: totalAmount`. Settling a bill is a cash movement, not a supply: the input tax was already claimed when the bill was captured. So the AP control account is relieved by 100 of a 115 payment while the subledger settles 115, and input VAT is claimed a second time. The customer arm is the exact mirror, inserting `customer_payments.total_amount = totalAmount` against an AR credit of `netAmount`.
- Trigger: Allocate a R1,150 supplier payment with VAT "Standard 15%" selected. AP debit R1,000, VAT input debit R150, bank credit R1,150, supplier payment document R1,150. GL AP and AP aging now differ by R150, and the VAT201 claims R150 twice.
- Confidence: HIGH
- Evidence: `{ glAccountId: apAccountId, debit: netAmount, ... }` … `{ glAccountId: bankAccountId, credit: totalAmount }` … `await recordSupplierBankPayment({ ..., amount: totalAmount, ... })`

### [CRITICAL] Bank rules reproduce the same VAT split, unattended, across a whole sweep
- File: `src/modules/accounting/services/bank/bankRulesMatchingHelpers.ts:125-158`, `bankRuleAutoPostLine.ts:131-140, 238-250`, with `gl/ruleVatResolution.ts:57-59`
- Bug: `resolveRuleVatCode` returns early for any alloc type that is not `account`, so a rule's `vat_code` passes through untouched for supplier and customer rules. `autoPostRuleLine` then builds the same net-AP-plus-VAT journal and calls `recordSupplierBankPayment` with the gross amount. Unlike the attended path, nobody is shown a warning, and the rule sweep applies it to every matching line.
- Trigger: Create an auto-post bank rule with a supplier selected and VAT code "Standard 15%" (the form shows the VAT selector regardless of the supplier). Run Apply Rules over a month of payments; every line under-relieves AP by its VAT and re-claims that VAT.
- Confidence: HIGH
- Evidence: `if (allocType !== 'account') { return { vatCode: requestedVatCode, denied: false, ... } }`

### [CRITICAL] `syncBankFeed` writes randomly generated fake transactions into a real company's ledger
- File: `src/modules/accounting/services/bank/openBankingSyncService.ts:22-41, 188-202`
- Bug: For providers `basiq`, `tink` and `plaid` the sync path calls `buildSampleTransactions()`, which invents 5-10 rows of `Math.random()` amounts with descriptions like "Eskom payment", and inserts each into `bank_transactions` with `status='imported'` for the caller's real company and bank account. `createBankFeedConnection` accepts all three providers. Only `manual_csv` and `extension` short-circuit before the stub generator.
- Trigger: Create a bank feed connection with provider `basiq` and press Sync. Up to ten invented transactions are written permanently and then flow into coverage, bank rules, allocation and auto-post.
- Confidence: HIGH
- Evidence: `const amount = (isDebit ? -1 : 1) * parseFloat((Math.random() * 5000 + 100).toFixed(2));`

### [CRITICAL] Capture inbox addresses carry 24 bits of entropy with no global uniqueness, so a collision routes another tenant's invoices into your company
- File: `src/modules/accounting/services/capture/captureInboxService.ts:47-53`, consumed at `inboundEmailService.ts:84-98`
- Bug: `generateInboxAddress` mints `cap-<6 hex>@inbox.isaflow.co.za`, about 16.7 million values. The table is unique only on `(company_id, channel, address)`, so the same address can be minted for two companies and the retry-on-conflict loop never fires. Ingestion resolves the company with `WHERE address = ... AND is_active = true ... LIMIT 1` and no ordering, so whichever row Postgres returns wins.
- Trigger: Two tenants receive the same generated address, a birthday collision of roughly 3% at a thousand tenants. A supplier emails an invoice to that address and the document, its bytes and its capture event are inserted under the wrong company, where that tenant's bookkeeper can open and post it.
- Confidence: HIGH
- Evidence: `crypto.randomBytes(4).toString('hex').slice(0, 6)` and `WHERE address = ${toAddress} AND is_active = true AND channel = 'email' LIMIT 1`

### [CRITICAL] Inbound WhatsApp resolves the company from the destination number alone
- File: `src/modules/accounting/services/capture/whatsAppInboundService.ts:86-106`
- Bug: The company is chosen by `SELECT ... FROM capture_inboxes WHERE address = ${toNumber} AND channel = 'whatsapp' ... LIMIT 1`. There is no global uniqueness on the address, and the outbound side falls back to a single shared default number. Two tenants on the same WhatsApp Business number share one destination address and `LIMIT 1` silently picks one.
- Trigger: A user at Company B photographs a receipt. It is stored as Company A's captured document, and any bank-transaction attachment lands in A's books while B never sees the receipt.
- Confidence: HIGH, contingent on the deployment sharing a number
- Evidence: `WHERE address = ${toNumber} AND channel = 'whatsapp' AND is_active = true LIMIT 1`

### [HIGH] Reversing one leg of a transfer leaves the counterparty bank line allocated against a reversed journal
- File: `src/modules/accounting/services/bank/bankAllocationService.ts:655-666` with `bankTransferAutoLink.ts:82-101`
- Bug: Allocating a transfer auto-links the opposite bank's statement line, setting it to `allocated` with `matched_journal_line_id` pointing at the same journal. `reverseReconciledTransaction` posts the contra and resets only the row it was given (`WHERE id = ${bankTxId}`). The counterparty row keeps `status='allocated'` and a link to a journal that has been reversed.
- Trigger: Allocate a transfer from Bank A to Bank B while both statements are imported, then reverse it. Bank A returns to `imported`; Bank B stays `allocated` forever, is excluded from every re-allocation path (which requires `imported`), and the reconciliation for Bank B silently counts it.
- Confidence: HIGH
- Evidence: the reset UPDATE's only predicates are `id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`

### [HIGH] `reconciled_balance` double-counts every matched transaction, and an adjustment entry never reaches the figure it exists to correct
- File: `src/modules/accounting/services/bank/bankReconciliationService.ts:262-277, 151-178`
- Bug: `updateReconciledBalance` sets `reconciled_balance = gl_balance + SUM(amount)` over transactions in `matched`/`reconciled`. But `matchTransaction` links a bank line to an *existing posted* journal line, which is already inside the `gl_balance` snapshot, so each matched amount is counted twice. Separately, `gl_balance` is a snapshot written at `startReconciliation` and never refreshed, so the adjustment journal `createAdjustmentEntry` just posted is absent from the recomputed figure. `difference` is `statement_balance - reconciled_balance` (migration 203), and `completeReconciliation` refuses anything over one cent.
- Trigger: Start a reconciliation, auto-match ten transactions, then raise one adjustment to close a small gap. `reconciled_balance` jumps by the sum of all ten matched amounts and does not include the adjustment. The reconciliation cannot be completed, or is completed only after further bogus adjustments.
- Confidence: HIGH
- Evidence: `SET reconciled_balance = gl_balance + COALESCE((SELECT SUM(amount) FROM bank_transactions WHERE ... status IN ('matched','reconciled')), 0)`

### [HIGH] Customer-rule auto-post credits AR in the GL and writes nothing to the AR subledger
- File: `src/modules/accounting/services/bank/bankRuleAutoPostLine.ts:158-251`
- Bug: The supplier arm creates a payment document through `recordSupplierBankPayment`. There is no customer equivalent anywhere in the function: a rule with a customer set posts Dr Bank / Cr AR control and stops. No receipt is created and `customer_invoices.amount_paid` is untouched.
- Trigger: An auto-post rule with a customer selected matches a R10,000 deposit. The AR control account falls R10,000; the customer's aging still shows R10,000 outstanding. This is the same defect class that #340 fixed on the AP side.
- Confidence: HIGH
- Evidence: only `if (allocType === 'supplier' && supplierId && !isDeposit) { await recordSupplierBankPayment(...) }` exists

### [HIGH] Best-effort SQL after a bank import runs without a savepoint and aborts the whole import transaction
- File: `src/modules/accounting/services/bank/bankImportService.ts:219-294`
- Bug: `importParsedTransactions` runs inside the `withAuth` request transaction. The auto-link UPDATE and the auto-post `sweep()` are wrapped in try/catch and logged as "non-fatal", but neither takes a savepoint. Any Postgres error inside them aborts the surrounding transaction, so every later statement fails with 25P02 while the code believes it swallowed the error. `relinkTransferCounterparts` has the same shape.
- Trigger: The sweep hits a closed period or a balanced-trigger rejection. The catch logs "non-fatal", the request then 500s, and *no* transactions are imported despite a log line claiming the failure did not matter.
- Confidence: HIGH
- Evidence: `} catch (provErr) { log.warn('auto-post sweep failed after parsed import — non-fatal', ...); }` with unguarded `await sql\`...\`` before it

### [HIGH] Receipt-to-journal always claims input VAT, including on the meals and entertainment it deliberately routes to account 5600
- File: `src/modules/accounting/services/bank/receiptToJournalService.ts:56-69, 114-145`
- Bug: The merchant table maps Spur, Nandos, KFC, restaurant and cafe to account 5600 with type `meals`, and the journal builder unconditionally emits a VAT-input debit. Neither consumer applies the section 17(2)(a) denial resolver that the rule sweep and the auto-post gate both run.
- Trigger: Photograph a R1,150 Spur slip. It posts Dr 5600 R1,000, Dr VAT Input R150, Cr Bank R1,150, and auto-posts outright at confidence 0.85 and under R5,000. Entertainment input tax is denied under section 17(2)(a).
- Confidence: HIGH
- Evidence: `{ pattern: /spur|nandos|...|restaurant|cafe|coffee/i, accountCode: '5600', type: 'meals' }` alongside an unconditional `{ accountId: accountIds.vatInputAccountId, debit: vatAmount }`

### [HIGH] Customer-invoice match candidates drop every invoice carrying `client_id` instead of `customer_id`
- File: `src/modules/accounting/services/bank/bankMatchDbQueries.ts:107-108`
- Bug: An inner `JOIN customers c ON c.id = ci.customer_id` on the wrong column. The rest of the AR module reads `COALESCE(ci.client_id, ci.customer_id)`. Invoices whose `customer_id` is null vanish from the candidate list.
- Trigger: A receipt arrives for an invoice created through a path that populates only `client_id`. The operator is told there is no match for an invoice that plainly exists.
- Confidence: HIGH
- Evidence: `FROM customer_invoices ci JOIN customers c ON c.id = ci.customer_id`

### [HIGH] IMAP-mirrored invoices are never extracted because `file_type` is stored as a MIME type where the router expects an extension
- File: `src/modules/accounting/services/capture/imapMirrorService.ts:216-230` versus `captureRouterService.ts:59-70`
- Bug: The IMAP ingest writes `application/pdf` into `captured_documents.file_type`, while every other ingest path writes `pdf`. The router feeds that column to a lookup keyed by extension, gets `undefined`, falls to `application/octet-stream`, takes the unsupported-mime branch and returns null. The event is still marked `extracted`.
- Trigger: Connect an IMAP mailbox and let the poller ingest a supplier PDF. The document shows a green "extracted" status with null vendor, null date and null amount, and can never be posted.
- Confidence: HIGH
- Evidence: `const mime = (att.contentType ?? 'application/octet-stream').toLowerCase();` written into `file_type`

### [HIGH] `auto_publish` self-promotes: the learning counter counts the rule confirming its own default
- File: `src/modules/accounting/services/capture/supplierRulesService.ts:197-276`, driven from `pages/api/accounting/capture/[id]/post.ts:178-186`
- Bug: `recordCoding` increments `learned_sample_count` whenever the posted GL account equals the rule's own default, and flips `auto_publish` at five. The caller passes `codingRule?.defaultGlAccountId` read back from the same rule, so the match is true by construction on every capture-post, including the route-to-review branch where no human confirmed anything.
- Trigger: A bookkeeper codes one invoice for a supplier. Four more arrive by email and are merely routed to review. On the fifth, `auto_publish` turns on and that supplier's invoices are thereafter inserted as `approved` with no review and no amount cap.
- Confidence: HIGH
- Evidence: `const shouldPromote = !rule.autoPublish && newCount >= PROMOTION_THRESHOLD;` with the caller supplying the rule's own default

### [MEDIUM] Auto-post gate sweep has no savepoint, so one failed row makes every later row report a bogus skip reason
- File: `src/modules/accounting/services/bank/autoPostGateService.ts:292-351`
- Bug: The per-row try/catch takes no savepoint. A SQL failure in `allocateTransaction`/`postProvisional` aborts the enclosing transaction; the catch swallows it and the loop continues, so rows 4 through 50 all fail on the poisoned transaction. The rule sweep next door wraps each line in `withSavepoint`, so the omission is not deliberate.
- Trigger: Sweep 50 rows where row 3 hits a constraint. Rows 4 to 50 are reported "skipped: current transaction is aborted", the closing run UPDATE throws, and the rows that did post are rolled back.
- Confidence: HIGH
- Evidence: `} catch (err) { skipped.push({ txId: row.id, reason }); }` with no `withSavepoint`, versus `withSavepoint('rule_autopost_line', ...)`

### [MEDIUM] Rule `match_pattern` is concatenated into ILIKE unescaped, and `exact` is not exact
- File: `src/modules/accounting/services/bank/bankRulesMatchingHelpers.ts:19-27`, `bankRulesMatchingService.ts:88-104`
- Bug: Both the suggestion SQL and `toSqlPattern` build `'%' || match_pattern || '%'` without escaping LIKE metacharacters. A `%` in a user's pattern matches anything and `_` matches any character. `match_type = 'exact'` resolves to a bare ILIKE, so it is neither case-sensitive nor metacharacter-safe.
- Trigger: A rule "Discount 50%" with auto-post enabled matches far more than intended and posts journals against transactions the user never meant to capture.
- Confidence: HIGH
- Evidence: `case 'contains': return \`%${matchPattern}%\`;` and `case 'exact': return matchPattern;`

### [MEDIUM] Supplier-invoice match candidates score the gross total and ignore what is already paid
- File: `src/modules/accounting/services/bank/bankMatchDbQueries.ts:52-84`
- Bug: The query selects `si.total_amount` and both the ordering and `scoreAmount` use it, even though the status filter explicitly includes `partially_paid`. The customer-side function on the same file correctly nets `amount_paid`.
- Trigger: A R10,000 bill with R7,000 paid, and a R3,000 payment arrives. The amount score is zero, the correct invoice ranks below noise, and the candidate row displays R10,000.
- Confidence: HIGH
- Evidence: `ORDER BY ABS(si.total_amount - ${absAmount}::NUMERIC)` and `const candAmount = Number(row.total_amount);`

### [MEDIUM] Auto-post undo counts reversals that reversed nothing, and a failed reversal still marks the run undone
- File: `src/modules/accounting/services/bank/autoPostUndoService.ts:39-85`
- Bug: A row with neither `matched_journal_line_id` nor `provisional_je_id` skips both branches yet increments `reversed`. Separately, the catch counts a skip but the run is unconditionally stamped `undone_at`, so it can never be re-run to finish. The catch also has no savepoint.
- Trigger: A run containing a row whose journal was already reversed manually reports "reversed: 1" with nothing touched. A genuine failure on row 2 of 10 marks the run undone and strands rows 3 to 10.
- Confidence: HIGH
- Evidence: the `if (tx.matched_journal_line_id) ... else if (tx.provisional_je_id) ...` pair followed unconditionally by `reversed += 1;`

### [MEDIUM] `matchTransaction` stamps an unvalidated journal line id
- File: `src/modules/accounting/services/bank/bankTxStatusMutations.ts:69-92`, route `pages/api/accounting/bank-transactions-action.ts:90`
- Bug: `journalLineId` arrives from the request body validated only as a UUID. Neither the route nor the service checks that the line belongs to this company, sits on this bank account, or is not already matched to another transaction. The display lateral is company-guarded, so the wrong link is invisible on screen.
- Trigger: Post a match action naming any UUID-shaped journal line. The bank transaction is stamped `matched` against a line that may belong to another tenant or to an unrelated account, and it is then counted by the reconciliation and excluded from auto-match candidates.
- Confidence: HIGH
- Evidence: `SET status = 'matched', matched_journal_line_id = ${journalLineId}::UUID` with no ownership predicate

### [MEDIUM] `relinkTransferCounterparts` can bind one journal line to two bank transactions
- File: `src/modules/accounting/services/bank/bankTransferLinkService.ts:36-96`
- Bug: `DISTINCT ON (bt_new.id)` stops one new transaction matching twice, but nothing stops two different imported transactions matching the same source allocation and receiving the same `target_je_line_id`. The catch also swallows without a savepoint, poisoning the caller's transaction.
- Trigger: Import a statement containing two identical-amount transfers within the two-day window. Both are set to `allocated` against the same journal line, so the same journal is claimed twice and the second transfer is never posted.
- Confidence: MEDIUM
- Evidence: `JOIN source_allocs sa ON (ABS(bt_new.amount + sa.src_amount) < 0.01 AND ...)` with `DISTINCT ON (bt_new.id)` only

### [MEDIUM] OFX, QIF and MT940 imports bypass the empty-parse guard and report a clean import of zero rows
- File: `src/modules/accounting/services/bank/bankStatementParseService.ts:58-70`
- Bug: `requireTransactions()` exists because a parser that fails to map a file returns an empty result that reads as success. It is applied to every CSV branch but not to the `ofx`, `qif` or `mt940` branches.
- Trigger: Upload an OFX whose tags the parser does not recognise, or pick the wrong file type. The response is "imported: 0, duplicates: 0, parseErrors: []" with no error at all.
- Confidence: HIGH
- Evidence: `if (fileType === 'ofx') return parseOfxStatement(csvContent);` versus `return requireTransactions(parseFNBStatement(csvContent), format, csvContent);`

### [MEDIUM] `bulkAcceptTransactions` reports every id as accepted even when nothing was updated
- File: `src/modules/accounting/services/bank/bankTransactionQueryService.ts:225-231`
- Bug: `lib/neon` only exposes `res.rows`, so an UPDATE without RETURNING yields an empty array. The `count` probe is always undefined and the function returns `ids.length`, the caller's own input.
- Trigger: Bulk-accept 40 rows of which 30 are already reconciled. The API and the log both report 40 accepted while 10 changed.
- Confidence: HIGH
- Evidence: `const count = (result as unknown as { count?: number }).count ?? ids.length;`

### [MEDIUM] The legacy Stitch feed service joins the vestigial `bank_accounts` table, so listing, syncing and disconnecting all fail silently
- File: `src/modules/accounting/services/bank/bankFeedConnectionService.ts:64-134`, `bankFeedSyncService.ts:75-120`
- Bug: Every query resolves the connection through `INNER JOIN bank_accounts ba ON ba.id = bfc.bank_account_id`. Since migration 483 that column points at `gl_accounts`, and `bank_accounts` holds zero rows in production, so the join matches nothing.
- Trigger: A company with live feed connections gets an empty list from the connections endpoint, and disconnecting one throws "Bank feed connection not found", leaving no way to revoke a live feed from that route.
- Confidence: HIGH
- Evidence: `FROM bank_feed_connections bfc INNER JOIN bank_accounts ba ON ba.id = bfc.bank_account_id`

### [MEDIUM] Statement reconciliation lets one ledger invoice match many statement lines
- File: `src/modules/accounting/services/capture/supplierStatementMatchHelper.ts:82-217`
- Bug: `matchLine` searches the full invoice array on every call and matched invoices are never removed from the pool, so two statement lines with the same reference or amount both bind to the same invoice. The genuinely unmatched second invoice is then reported as missing from the statement.
- Trigger: A supplier bills the same retainer twice in a month and both invoices exist. Both statement lines match the first, the second is flagged as a gap that does not exist, and the missing-invoice count is wrong.
- Confidence: HIGH
- Evidence: `const candidates = invoices.filter((inv) => Math.abs(inv.totalAmount - debit) <= threshold);` called per line against an unmutated pool

### [MEDIUM] Capture duplicate detection ignores invoice status, so a cancelled invoice permanently blocks re-capture
- File: `src/modules/accounting/services/capture/captureDeduplicationService.ts:68-111`
- Bug: Neither the fingerprint query nor the fuzzy query filters on `status`, and `supplier_invoices` includes `cancelled`. Any hit returns `duplicate_blocked` and the API answers 409.
- Trigger: An invoice is captured at the wrong amount, cancelled, and the corrected PDF re-forwarded. The fuzzy branch matches the cancelled row and refuses the re-capture with no override on that path.
- Confidence: HIGH
- Evidence: `WHERE company_id = ... AND supplier_id = ... AND total_amount BETWEEN ${amtLow} AND ${amtHigh} AND invoice_date BETWEEN ...`

### [MEDIUM] IMAP scan cursor advances past messages whose ingest failed
- File: `src/modules/accounting/services/capture/imapMirrorService.ts:301-362`
- Bug: `maxUidSeen` is bumped at the top of the loop for every message scanned, before ingest is attempted. A throw is logged and counted as an error, but the cursor still advances, and UIDs are monotonic.
- Trigger: Storage returns a 500 for one attachment mid-scan. That invoice's UID falls permanently below the cursor and never enters the capture inbox; the only trace is one scan-log row.
- Confidence: HIGH
- Evidence: `if (uid > maxUidSeen) maxUidSeen = uid;` before the ingest try/catch, with `updateCursor(conn, conn.folder, maxUidSeen)` after the loop

### [MEDIUM] `attachEvidenceToProvisional` swallows SQL errors inside the caller's transaction
- File: `src/modules/accounting/services/capture/evidenceAttachmentService.ts:36-136`, same shape in `captureBankTxAttachService.ts:83-124`
- Bug: The whole body is one try/catch documented as non-throwing "so the caller can continue", but it runs on the shared request connection with no savepoint. A malformed extracted date cast to `::DATE` raises 22007, aborts the transaction, and every later statement fails with 25P02.
- Trigger: Post a captured document whose extracted invoice date is not a valid date. The invoice insert has already run, the evidence step poisons the transaction, and the whole capture-post rolls back behind a log line claiming the attach was non-blocking.
- Confidence: MEDIUM
- Evidence: `} catch (err) { log.warn('attachEvidenceToProvisional failed — continuing', ...); return nothing; }`

### [MEDIUM] A VAT registration number is written into the `vat_code` column and becomes the supplier's default
- File: `pages/api/accounting/capture/[id]/post.ts:182` into `supplierRulesService.ts:178-244`
- Bug: The fallback is `vatCode: codingRule?.defaultVatCode ?? extracted.vendorVatNumber ?? null`. A SARS registration number is not a VAT code, and the column is a `VARCHAR(20)` so nothing errors. `predictFromHistory` later returns that string as the predicted VAT code for provisional posting.
- Trigger: The first capture-post for a supplier with no rule yet, on a document where the vendor VAT number was extracted. The supplier's default VAT code becomes a ten-digit number.
- Confidence: HIGH
- Evidence: `vatCode: codingRule?.defaultVatCode ?? extracted.vendorVatNumber ?? null,`

### [MEDIUM] WhatsApp amount parser glues space-separated digit groups
- File: `src/modules/accounting/services/capture/whatsAppTextCommandParser.ts:21-58`
- Bug: The amount class `[,\s\d]*` consumes spaces and digits, then whitespace is stripped. This is deliberate for "R1 250" but indistinguishable from an unrelated trailing number. Separately, the documented examples without an "R" or "rand" match neither alternative and are dropped with no event.
- Trigger: "paid R450 2 coffees at Seattle" parses as R4502, and that is the figure the reviewer reads when promoting the capture event.
- Confidence: HIGH
- Evidence: `/\bR\s*([\d][,\s\d]*(?:\.\d{1,2})?)\b|.../i` with `.replace(/[\s,]/g, '')`

### [MEDIUM] Twilio webhook retries re-ingest the same document
- File: `src/modules/accounting/services/capture/whatsAppInboundService.ts:110-231`
- Bug: The code's own comment acknowledges there is no `MessageSid` dedupe. Only the bank-transaction attachment path dedupes, and on filename. The handler does media fetch, storage upload and two inserts before returning.
- Trigger: The webhook times out after the first media is stored. Twilio retries, producing a second captured document and capture event for the same invoice, both extracted and both offered for posting.
- Confidence: HIGH
- Evidence: the file's own comment `// ... (no MessageSid dedupe)`, with no uniqueness constraint behind it

### [MEDIUM] OCR statement commit counts conflicting rows as imported
- File: `src/modules/accounting/services/bank/bankStatementOcrService.ts:185-199`
- Bug: The insert uses `ON CONFLICT DO NOTHING` but `insertedCount++` runs unconditionally, and the persisted `skipped` figure is derived by subtraction, folding real duplicates into "skipped".
- Trigger: Re-commit overlapping rows. `bank_statement_imports.imported_count` claims more rows than landed, and anyone reconciling a period against that count gets a wrong figure.
- Confidence: HIGH
- Evidence: `ON CONFLICT DO NOTHING` immediately followed by `insertedCount++;`

### [MEDIUM] Allocation silently skips the bank_transactions write when the bank journal line cannot be found
- File: `src/modules/accounting/services/bank/bankAllocationService.ts:384-401, 586-596`
- Bug: Both `allocateTransaction` and `splitAllocateTransaction` guard the status UPDATE with `if (journalLineId)`. If the lookup returns nothing the journal is already posted and committed, but the transaction stays at `imported` with no link to it.
- Trigger: Any condition that makes the bank leg unfindable leaves a posted journal in the GL with the bank line still available for a second allocation, and both calls return success.
- Confidence: MEDIUM
- Evidence: `const journalLineId = jeLines.length > 0 ? String(jeLines[0]!.id) : null;` followed by `if (journalLineId) { await withTransaction(...) }`

### [LOW] Multi-doc match reports a matched cross-reference when the value is simply missing
- File: `src/modules/accounting/services/bank/multiDocMatchHelpers.ts:49-53`
- Bug: `amountsMatch` returns true when either side is null and `vendorNamesMatch` returns true below two names, so a document set where extraction failed reaches `full_match` with high confidence on data never read. The endpoint is advisory and posts nothing.
- Confidence: HIGH on behaviour, MEDIUM on impact
- Evidence: `if (a == null || b == null) return true;`

### [LOW] Feed duplicate lookups are not scoped by `company_id`
- File: `src/modules/accounting/services/bank/bankFeedSyncService.ts:139-144`, `openBankingSyncService.ts:52-68`
- Bug: Both checks filter on `bank_account_id` plus reference or amount with no company predicate. Not exploitable today because the bank account id is a company-unique `gl_accounts` id, but it violates the repo rule and is one schema change from a cross-tenant read.
- Confidence: MEDIUM
- Evidence: `SELECT id FROM bank_transactions WHERE bank_account_id = ${bankAccountId}::UUID AND bank_reference = ${tx.externalId} LIMIT 1`

### [LOW] `createAndSendQuery` sends the WhatsApp message before persisting the query row
- File: `src/modules/accounting/services/capture/bankTxQueryService.ts:64-86`
- Bug: The send is awaited first and the insert follows inside the request transaction, so a later failure rolls back the row after the message has left.
- Trigger: The client receives "please identify this transaction" but no query row exists, so their reply photo is never attached to the bank transaction.
- Confidence: HIGH
- Evidence: `const sendResult = await sendWhatsAppMessage(...)` preceding the `INSERT INTO bank_tx_queries`

---

## Clean on review

`bankTxLock.ts`, `bankAllocationUnwind.ts`, `bankAllocationBatchService.ts`, `bankAllocationRangeService.ts`, `bankReconciliationCancelService.ts`, `cashBalanceService.ts`, and all eight files in `services/reconciliation/` (`subledgerReconciliationService`, `unappliedCashService`, `unpostedDocumentService`, `reconcilingItemBuilders`, `reconcilingItemTypes`, `reconciliationMath`, `agedReportTotal`, `settlementFlagService`) — company scoping, numeric parsing and the two-bridge decomposition all check out.

Also clean: `bankStatementDedupHelpers`, `bankTxCursor`, `bankLineDirection`, `bankCoverageQueries`, `bankCoverageDirections`, `bankStatementCoverageService`, `bankOpeningBalanceService`, `hasBankAccountService`, `bankImportBatchQueryService`, `bankTxRowMapper`, `bankTxQueryFragments`, `bankTxFilters`, `absaScraperMapper`, `bankStatementImportErrors`, `bankAccountStatusService`, `openBankingTypes`, `bankFeedService`, `openBankingService`, the five VLM services (LLM output is coerced through typed helpers, never trusted raw), `bankTxAttachmentService`, `agentActivityService`, `provisionalDismissService`, `bankTransactionLookupService`, `bankRulesService` CRUD, `twilioMediaFetch` (SSRF allowlist correct), `auditTrailExportService` (portal token bcrypt-compared, expiry and revocation checked in SQL), `fourWayMatchService`, `autoPublishGateService`, `alertResolutionService`, `bankTxQueryMessage`, `captureQueryService`, `mirrorConnectionService`, `expectationCronService`, `whatsAppChaseService`, `whatsAppReplyService`.

`supplierGraphService.ts` writes tenant-supplied supplier names into the global `platform_shared.supplier_templates` and matches them back by normalised name. Worth a privacy review, but no concrete failure path was found to report as a bug.

## Out of scope, flagged

The South African number and date parsing itself (thousands separators, trailing minus, CR/DR suffix, DD/MM versus MM/DD) lives in `src/modules/accounting/utils/bankCsvParsers.ts` and the OFX/QIF/MT940 parsers. Those are outside this scope and were not audited.

## Files read

All 63 files in `/home/hein/Workspace/IsaFlow/src/modules/accounting/services/bank/`, all 8 in `/home/hein/Workspace/IsaFlow/src/modules/accounting/services/reconciliation/`, all 30 in `/home/hein/Workspace/IsaFlow/src/modules/accounting/services/capture/`, plus `/home/hein/Workspace/IsaFlow/src/lib/neon.ts`, `/home/hein/Workspace/IsaFlow/src/lib/fmtDate.ts`, `/home/hein/Workspace/IsaFlow/src/modules/accounting/services/gl/ruleVatResolution.ts`, `/home/hein/Workspace/IsaFlow/src/components/accounting/bank-rules/BankRuleForm.tsx`, `/home/hein/Workspace/IsaFlow/pages/api/accounting/bank-transactions-action.ts`, `/home/hein/Workspace/IsaFlow/pages/api/accounting/bank-transactions-bulk-commit.ts`, `/home/hein/Workspace/IsaFlow/pages/api/accounting/capture/[id]/post.ts`, `/home/hein/Workspace/IsaFlow/pages/api/accounting/capture/[id]/post-expense.ts`, `/home/hein/Workspace/IsaFlow/pages/api/accounting/receipt-to-journal.ts`, and migrations 201, 203, 233, 409, 412 under `/home/hein/Workspace/IsaFlow/scripts/migrations/sql/`.
