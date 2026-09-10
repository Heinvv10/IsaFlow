# Retained merge journal source authority

Exactbase01a1bb36e, isolatedfeat/mcp-history-source-authority-20260910. Workerowns new controlChangeHistoryJournalSources.ts, controlChangeHistoryService.ts integration and focusedunit/actualPGtests. Rootfreezesmap/contracts, no registry/migration. Mergeworker confirms exact BOTH images {header,lines,accounts}, fullowned persistedheader, allownedlines andallreferencedownedGLaccounts. Action accounts_merged:<server-created UUID>, existing operationId mayhavenoapprovedoperation/effect metadata. Source is retained header.source; current mutablejournal cannot replace it.

Confirmed source inventory: GL_ENTRY_SOURCES26 mirrors509; auto_payroll also emitted by taxDirectivePaymentService169–197 with employee name/SARSdirective number inheader andindividualgross/PAYE/netlines. Rootapproved read:payroll-sensitive (includesrequiredread:payroll dependency) for thatsource. auto_migration is emitted bothopeningbalance andAR/APmigration; use conservativeunion. Expenseclaims may carryindividualfree-text claimlines; there is no expense-specific effective-permission vocabulary, so proposed conservativecrossdomain ceiling below requiresrootfreeze, not silentunsupportedknownsource.

All26 source mapping proposals (existing read:audit+read:reports always remain):
- manual, auto_adjustment, auto_recurring, year_end: noadditionaldomain beyondreports.
- auto_invoice, auto_grn, auto_credit_note, auto_supplier_invoice, auto_write_off, auto_purchase_order: read:invoices.
- auto_payment, auto_supplier_payment, auto_batch_payment, auto_bank_recon: read:bank-tx AND read:invoices (bankrecon cancarryinvoice allocation/party material).
- auto_vat_adjustment, auto_vat_submission: read:vat.
- auto_depreciation, auto_asset_disposal, auto_asset_expense: read:assets.
- auto_payroll: read:payroll-sensitive (dependentread:payroll).
- auto_bank_transfer, auto_loan_payment: read:bank-tx.
- auto_expense_claim, auto_expense_receipt: read:bank-tx AND read:invoices AND read:payroll-sensitive, conservative fullindividualreimbursementimage ceiling; rootmustfreeze orrefine using actualsourcecontract.
- auto_gl_import: read:imports.
- auto_migration: read:imports AND read:invoices AND read:bank-tx.

HelperassertJournalMergeHistorySources(ctx,{entityType,entityId,action},protectedValues): returnsvoid. Applies ONLY journal_entry actionprefix accounts_merged: (validatefullactionUUID). Bothbefore/after mustbe plain fullimages withheader.id==entityId/header.company_id==issuedcompany andsourceownkeyinclosedmap; no missingfallback. Unionbothsourcepermission requirements fixedcodeunit order then assertEffectivePermission for each before projectHistoryValues/output. accounts/lines mustbe arrays; ensure retained rowparent/company identity as actualfullshape permits, unknown/missingmetadata failclosed. Existing unrelatedminimaljournal history behavior unchanged. Decrypt boundedpageinternally, authorizecompletepage beforeprojection/return; exceptiononlaterrow returnsnopartialpage. Existing oversizedmetadata path mustnotexpose confidentialpayload andexisting sourceoperation authority stays.

TestsFIRST: closedmapcoversall26; payroll->manual andmanual->payroll both require current payroll-sensitive, invoice/bank transition union; malformedmissing/unsupportedsource, foreignheader/line/account identity; no liveSQLsourcequery. ActualPG recordCommittedChange capturesfullsyntheticmanual/payrollimages underrealissuedapp_user; reports/auditallowed butpayroll-sensitive denied cannotreadretainedpayroll, manualpositive remains; retainedpayroll/currentmanual mutationstilldenied; authorizedcurrentrights allowsfullhistoricalsource; foreigntenant refuses. Testsuseactualprotectedwriter andencryption, notmockedreturn. Realmergeproducer followupdepends mergeworkerverifiedcommit, request beforeadoptingitschanges. NoPG/heavy untilrootlease, no productionclaim.
