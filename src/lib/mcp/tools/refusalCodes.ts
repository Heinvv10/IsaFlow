/**
 * The allowlist of refusal codes whose messages an MCP tool may show an agent
 * verbatim (toolHelpers.safeErrorText / isRefusalCode). Moved out of
 * toolHelpers.ts unchanged (R-035 PR5 round 1, the 300-line cap).
 */
import { SYSTEM_ROLE_REFUSAL_CODES } from './systemRoleRefusalCodes';

/**
 * The codes this codebase's own refusal classes carry — the complete set of
 * `readonly code = '…'` declarations under `src/`, kept in sync by
 * `tests/unit/mcp/typedRefusalReachesAgent.test.ts`, which fails when a new one
 * is declared and not listed here.
 *
 * An ALLOWLIST, not a shape test. A shape test asked "does this code look like
 * ours" and admitted anything SCREAMING_SNAKE that reached the boundary —
 * Node's own error codes are exactly that (`ERR_INVALID_ARG_TYPE`,
 * `ERR_OUT_OF_RANGE`, undici's `UND_ERR_*`), and each carries an internal
 * message naming arguments and received values. A `code` an attacker can
 * influence would have passed too. Identity closes the class; shape only
 * narrowed it.
 *
 * Failing closed here costs a new refusal class its wording until it is added,
 * which the census test surfaces the moment it is written.
 */
export const REFUSAL_CODES: ReadonlySet<string> = new Set([
  'ADJUSTMENT_NOT_APPROVABLE',
  // Forensic-controls step 2 (bank/bankControlRefusal's BankControlError, whose
  // code is a constructor argument): under enforcement an agent may not reverse a
  // bank allocation (AGENT_FORBIDDEN), the reverser may not be its allocator
  // (ALLOCATOR_MAY_NOT_REVERSE), nor the allocator the statement's importer
  // (IMPORTER_MAY_NOT_ALLOCATE). Fixed messages naming no id, amount or table;
  // raised before any write.
  'AGENT_FORBIDDEN',
  'ALLOCATOR_MAY_NOT_REVERSE',
  'APPROVAL_REQUEST_LOCK_TIMEOUT',
  // R-035 approval gate (gl/approvalGate): names the caller's own document
  // number, the demanded role and the rule's name; raised before any write.
  'APPROVAL_REQUIRED',
  // R-035 N1: the approval rules or the amount moved while a request was being
  // raised (gl/approvalDocumentErrors). Names the caller's own document type
  // and id; nothing is written. No MCP tool raises requests (Q6).
  'APPROVAL_RULES_CHANGED',
  'BANK_ALLOCATION_REFUSED',
  // sync_bank_dimensions / the tag write-through (gl/dimensions/dimensionBankSync): a window over the row cap, a bank row
  // changed while the sync ran (rolled back), an idempotency key that names a batch of the other kind or window. Names
  // only the caller's own key, window and counts.
  'BANK_DIMENSION_SYNC_REFUSED',
  'BANK_MATCH_UNAVAILABLE',
  'BANK_TX_ALLOCATED',
  'BANK_TX_LOCK_TIMEOUT',
  'BANK_TX_NOT_POSTED',
  // Listed because every `readonly code` must be; no MCP tool reverses or
  // processes a batch yet, so no agent can receive it today.
  'BATCH_ALREADY_REVERSED',
  // R-035 PR5: a batch that is no longer a draft when approve runs; names its
  // status only, raised before any write. No MCP tool approves a batch today.
  'BATCH_NOT_APPROVABLE',
  // R-035 PR5: a batch sent to the bank (eft-generate / netcash) while still a
  // draft (or cancelled / reversed), enforcement on or off; names its status
  // only, raised before any write.
  'BATCH_NOT_SENDABLE',
  'BATCH_NOT_PROCESSABLE',
  'BILL_LINE_ACCOUNT_REFUSED',
  // A captured document already claimed for posting, or rejected (K-072), or its
  // file already posted from another upload / held by another request (R-088).
  // Four fixed messages naming no id, amount or table, raised only after the
  // service read the document by company_id — the caller's own document.
  'CAPTURED_DOCUMENT_ALREADY_POSTED',
  'CAPTURE_EVENT_LOCKED',
  // Another request holds the capture row (K-072): says "retry", names only the
  // id the caller passed, and the row is locked by id AND company_id.
  'CAPTURE_ROW_LOCK_TIMEOUT',
  // A manual expense-claim line's source document could not be claimed (R-105,
  // R-088). Eight fixed messages naming no id, amount or table, raised before any write;
  // the claim is scoped by company_id. No MCP tool creates expense claims today.
  'CLAIM_SOURCE_DOCUMENT_REFUSED',
  // R-161 client group fence: names only the id the caller passed; raised before any write.
  'CLIENT_GROUP_NOT_FOUND',
  // A customer credit note's header job / CC1 / CC2 / BU refused (ar/creditNoteHeaderTags): set on a
  // linked note, or a job not this company's / cancelled. Names only the caller's own job; pre-write.
  'CREDIT_NOTE_DIMENSIONS_REFUSED',
  'CREDIT_NOTE_LOCK_TIMEOUT',
  // FX PR0 (shared/documentCurrency): a currency code that is not three letters. Fixed sentence; pre-write.
  'CURRENCY_CODE_INVALID',
  'CUSTOMER_INVOICE_LOCK_TIMEOUT',
  'CUSTOMER_NOT_FOUND',
  // CC1/CC2/BU refusals (gl/dimensions): an unknown reference, a project whose
  // FNO conflicts, dimensions on a settlement, a COS line with no project where
  // required. Names only the caller's own references and its masters' codes;
  // raised before any write.
  'DIMENSION_REFUSED',
  // R-035: approve on a request whose document changed since it was raised.
  // Names only the request id the caller passed; nothing is written.
  'DOCUMENT_CHANGED',
  'DOCUMENT_CLAIM_LOCK_TIMEOUT',
  // Inactive or not-this-company line account (gl/documentLineAccountGuard): names only the caller's own account.
  'DOCUMENT_LINE_ACCOUNT_REFUSED',
  'DOCUMENT_NUMBER_LOCK_TIMEOUT',
  // R-035 review HIGH-1, invoices and bills since FX PR0 (shared/documentCurrency):
  // names the currency and the rate the caller sent; raised before any write.
  'EXCHANGE_RATE_INVALID',
  // R-035: approve without the digest the approver was shown. Names only the request id.
  'EXPECTED_DIGEST_REQUIRED',
  // FX PR0 (shared/documentCurrency): a foreign-currency document while the company has not
  // enabled them. Names the caller's currency and the functional one; raised before any write.
  'FOREIGN_CURRENCY_DISABLED',
  // FX PR0 (shared/documentCurrency): settling a foreign-currency document, whatever the switch.
  // Names the document's currency; raised before any write.
  'FOREIGN_CURRENCY_SETTLEMENT',
  'GL_ACCOUNT_LOCK_TIMEOUT',
  // export_gl_lines table=counterparties without read:contacts (tools/exportGlLines):
  // names the missing scope and how to grant it; raised before any query.
  'GL_EXPORT_SCOPE_REFUSED',
  // Confirming a manual journal as the correction of an auto-posted line was
  // refused (R-079). Twelve fixed messages written for the user, naming no id,
  // amount or table, raised before any write. No MCP tool reaches it today.
  'HAND_CORRECTION_REFUSED',
  // D1 (gl/headerAccountGuard): a new journal line on a balance-sheet header. Names the caller's own account code
  // and line number; raised before the writer's first INSERT.
  'HEADER_ACCOUNT_REFUSED',
  // The FOR SHARE read of an invoice's line accounts lost a lock race (55P03 / 40P01): says "retry".
  'INVOICE_LINE_ACCOUNT_LOCK_TIMEOUT',
  // A customer invoice line's revenue account, job or CC1 / CC2 / BU (with the customer's FNO) refused
  // (ar/invoiceLineCoding): names only the caller's own account, job or cost centre.
  'INVOICE_LINE_CODING_REFUSED',
  // Engagement Budget out of range (normaliseBudgetAmount): one fixed sentence, raised before any write.
  // No MCP tool reaches it today (no tool writes a job); registered so the census holds.
  'JOB_BUDGET_INVALID',
  // Moving a job to another client while its time entries are its current client's (mig 851). Fixed sentence.
  // No MCP tool reaches it today (no tool writes a job); registered so the census holds.
  'JOB_CLIENT_HAS_ENTRIES',
  'JOURNAL_REVERSAL_LOCK_TIMEOUT',
  'LOAN_POST_LOCK_TIMEOUT',
  // R-035: enabling approval enforcement for a type not yet wired. Names only the type.
  'NOT_ENFORCEABLE',
  'PAYMENT_LOCK_TIMEOUT',
  'PAYMENT_POSTED_DURING_VOID',
  'PAYROLL_LOAN_LOCK_TIMEOUT',
  'PAYROLL_RUN_JOURNAL_POSTED',
  // W3-01 round 6: the payroll reversal guard's 5s wait ran out (payrollJournalReversalGuard).
  'PAYROLL_RUN_LOCK_TIMEOUT',
  // R-073 practice client fence: names only the id the caller passed; raised before any write.
  'PRACTICE_CLIENT_NOT_FOUND',
  // Engagement Budgets job fence (assertJobForPracticeClient): names only the job id the caller passed (and, for
  // CLOSED, that job's status); raised before any write.
  'PRACTICE_JOB_CLOSED',
  'PRACTICE_JOB_NOT_FOUND',
  // Another request is posting a document with the same content (R-088): one
  // fixed "retry" sentence naming no document, raised before any write.
  'RECEIPT_POST_BUSY',
  'RECEIPT_REFUSED',
  'RECLASS_LINE_LOCK_TIMEOUT',
  // Rematch of a statement already marked reconciled (R-059 r11). The message
  // names no id, amount or table, and the service reads the statement by
  // company_id, so it can only ever describe the caller's own statement.
  // Bank reverse (and void_payment through it) on cash a completed or Sage
  // reconciliation holds — R-111. Pre-write, caller-facing.
  'RECONCILED_CASH',
  'RECONCILIATION_CLOSED',
  // A statement still being read, or whose read failed: commit/rollback/rematch/reconcile refuse it (migration 896).
  // Fixed wording, no id or table, raised before any write.
  'IMPORT_NOT_READY',
  'RECONCILIATION_NOT_READY',
  // D12: a write that would change a COMPLETED bank reconciliation (match/auto-match into it, a line of it, its
  // complete/cancel, a reversal or void of its cash). Names the account and statement date; raised before any write.
  'RECONCILIATION_COMPLETED',
  'RECURRING_INVOICE_LOCK_TIMEOUT',
  'RECURRING_INVOICE_NOT_DUE',
  'RECURRING_INVOICE_TEMPLATE_INVALID',
  'RECURRING_JOURNAL_LOCK_TIMEOUT',
  'RECURRING_JOURNAL_NOT_FOUND',
  'RECURRING_TEMPLATE_LINE_ACCOUNT',
  'RECURRING_TEMPLATE_LOCK_TIMEOUT',
  'RECURRING_TEMPLATE_NOT_DUE',
  'RECURRING_TEMPLATE_TOTALS_MISMATCH',
  'REVERSAL_BEFORE_ORIGINAL', // R-012: names only the caller's entry date and today; pre-write.
  'ROW_LOCK_TIMEOUT', // D8 round 9 (core/rowLockBudget): names the document; nothing acquired, retry.
  'RULE_AUTHORITY_REQUIRED',
  // Supplier bank verification (forensic-controls step 1): a bank file or
  // Netcash submission paying a supplier whose bank details are unverified;
  // names the caller's own suppliers, raised before anything is sent. Listed
  // because every `readonly code` must be; no MCP tool sends money.
  'SUPPLIER_BANK_DETAILS_UNVERIFIED',
  // A refund larger than the contact's on-account credit (migration 681). One fixed sentence written for the user, naming the contact, the two amounts
  // and the as-at date the caller itself supplied — no id, no table — and
  // raised BEFORE the journal posts, so there is nothing written to leak.
  'SUPPLIER_REFUND_REFUSED',
  'SUPPLIER_INVOICE_LOCK_TIMEOUT',
  'SUPPLIER_NOT_FOUND',
  'SUPPLIER_PAYMENT_NOT_FOUND',
  'SUPPLIER_PAYMENT_NOT_PROCESSABLE',
  'SUPPLIER_PAYMENT_REFUSED',
  ...SYSTEM_ROLE_REFUSAL_CODES,
  'TAX_DIRECTIVE_ALREADY_APPLIED',
  'TAX_DIRECTIVE_NOT_APPROVED',
  'TAX_DIRECTIVE_WITHOUT_EMPLOYEE',
  'TAX_DIRECTIVE_PAID',
  'TIME_ENTRIES_NOT_CLAIMED',
  'TIME_ENTRY_LOCK_TIMEOUT',
  // VAT adjustment approve/cancel refusals (reports/vatAdjustmentService): not found, not draft, contended.
  'VAT_ADJUSTMENT_REFUSED', 'JOURNAL_DATE_REFUSED', // latter: outside 1900..2199; the registry savepoint rolls back
  // Mark/unmark "VAT declared outside IsaFlow" refused: not owner/admin,
  // blank reason, document not found, or not currently marked (unmark) —
  // reports/vatDeclaredElsewhereService. Names no id/amount/table beyond the
  // caller's own document, scoped by company_id. Pre-write.
  'VAT_DECLARED_ELSEWHERE_FORBIDDEN',
  'VAT_DECLARED_ELSEWHERE_REFUSED',
  // R-032 L5: an approve/post/file/close act refused to a platform-admin
  // "Login as" session (auth/impersonationGuard). A fixed message naming no
  // id, amount or table; raised as the approving service's first statement,
  // before any read or write. Bearer callers carry no session id and are not
  // refused today — listed because every `readonly code` must be decided.
  'IMPERSONATION_FORBIDDEN',
  // R-035 review HIGH-2 (gl/approvalGateExempt): names the demanded role and the
  // caller's own; raised before an import writes anything.
  'IMPORT_APPROVAL_AUTHORITY_REQUIRED',
  'IMPORTER_MAY_NOT_ALLOCATE',
  // Step 2: a bank allocation's journal reversed through the GL under enforcement — reverse it from the bank line.
  'REVERSE_FROM_BANK_LINE',
  // Link/unlink a captured document to a posted journal refused: blank
  // reason, journal not found/not posted/reversed, document not found, or
  // the document already backs another claim (gl/journalDocumentLinkService,
  // VAT-gaps batch item 1). Names no id/amount beyond the caller's own
  // journal/document, scoped by company_id. Pre-write.
  'JOURNAL_DOCUMENT_LINK_REFUSED',
  // The exclusive VAT-lock key was not free within 5s (posts in flight).
  // Says "retry"; raised before any write.
  // Blocking VAT exceptions refused a lock/mark-submitted with no override, or
  // an override reason from a non-owner/admin (reports/vatGateOverrideService).
  // Names only the caller's own exception counts; pre-write.
  'VAT_GATE_BLOCKED',
  'VAT_GATE_OVERRIDE_FORBIDDEN',
  'VAT_LOCK_TIMEOUT',
  // A journal that moves a VAT-return figure, dated inside a locked (filed) VAT
  // period (gl/journalVatLockGuard). The message names the caller's own period
  // dates and the remedy — no id, amount or table — and is raised before the
  // write that would post.
  'VAT_PERIOD_LOCKED',
  // Lock/unlock of a VAT period refused (reports/vatPeriodLockBounds): a
  // future end, a span over 12 months, an overlap naming the caller's own
  // locked period, a blank unlock reason. Pre-write, no id or table named.
  'VAT_PERIOD_LOCK_REFUSED',
  'WIP_ENTRIES_LOCKED',
  'WRITE_OFF_INVOICE_REFUSED',
  'WRITE_OFF_NOT_APPROVABLE',
  // G-06 (gl/yearEndClosingNumber): a year closed and reversed more than 25 times, or a close whose reversal chain is too long to read; the messages name only the closing number.
  'YEAR_END_CLOSE_CHAIN_TOO_LONG',
  'YEAR_END_TOO_MANY_RECLOSES',
]);
