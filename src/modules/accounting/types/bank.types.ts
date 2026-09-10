/**
 * PRD-060: FibreFlow Accounting Module
 * Bank Reconciliation Type Definitions
 */

export type BankTxStatus = 'imported' | 'allocated' | 'matched' | 'reconciled' | 'excluded';
export type BankReconStatus = 'in_progress' | 'completed';
export type BankFormat = 'fnb' | 'standard_bank' | 'nedbank' | 'absa' | 'capitec' | 'generic' | 'ofx' | 'qif' | 'mt940' | 'unknown';

// ── Parsed Bank Transaction ──────────────────────────────────────────────────

export interface ParsedBankTransaction {
  transactionDate: string; // YYYY-MM-DD
  valueDate?: string;
  amount: number; // positive = deposit, negative = withdrawal
  description: string;
  reference?: string;
  balance?: number;
}

export interface BankCsvParseResult {
  transactions: ParsedBankTransaction[];
  errors: Array<{ row: number; error: string }>;
  bankFormat: string;
  /**
   * Account number extracted from the statement (PDFs only, when the parser
   * can find it in the header). Normalised — no spaces, dashes, or other
   * separators. Used by the import API to verify the uploaded statement
   * actually belongs to the bank account the user selected for import.
   *
   * Undefined for CSV imports (no header) or unknown bank formats where
   * the account number could not be located. In those cases the import API
   * allows the import to proceed but logs a warning.
   */
  accountNumber?: string;
}

// ── Bank Transaction (DB) ────────────────────────────────────────────────────

export interface BankTransaction {
  id: string;
  bankAccountId: string;
  transactionDate: string;
  valueDate?: string;
  amount: number;
  description?: string;
  reference?: string;
  bankReference?: string;
  status: BankTxStatus;
  matchedJournalLineId?: string;
  reconciliationId?: string;
  importBatchId?: string;
  /** Contextual reason recorded when this transaction was excluded */
  excludeReason?: string;
  /** Free-text notes attached to this transaction */
  notes?: string;
  /** Suggestion fields — populated by rules or classified import */
  suggestedGlAccountId?: string;
  suggestedSupplierId?: string;
  suggestedClientId?: string;
  suggestedCategory?: string;
  suggestedCostCentre?: string;
  suggestedVatCode?: string;
  /** Smart categorization confidence score (0-1) */
  suggestedConfidence?: number;
  /** LLM tier: categorization strategy used ('llm' | 'rule' | 'history' | ...) */
  suggestedStrategy?: string;
  /** Dimension fields — cost centres and business unit */
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
  createdAt: string;
  updatedAt: string;
  // Joined display fields
  bankAccountName?: string;
  matchedEntryNumber?: string;
  suggestedGlAccountName?: string;
  suggestedGlAccountCode?: string;
  suggestedSupplierName?: string;
  suggestedClientName?: string;
  cc1Name?: string;
  cc2Name?: string;
  buName?: string;
  /**
   * VAT treatment derived from the POSTED JOURNAL, not from the suggestion
   * columns — which the rule auto-post path NULLs on allocation, leaving the
   * screen to render "No VAT" over an entry that claimed input tax at 15%.
   * Present only for rows with a matched journal line.
   */
  postedVatCode?: 'none' | 'standard' | 'zero_rated' | 'exempt';
  /** Input/output tax actually posted, in rands. 0 when no VAT line exists. */
  postedVatAmount?: number;
  // Allocation tracking — populated when status is matched/reconciled
  allocationType?: 'account' | 'supplier' | 'customer' | 'transfer';
  /**
   * The GL account the money actually landed in, as "<code> <name>", resolved
   * from the posted journal — NOT the cached bank_transactions label, which the
   * rule auto-post path used to fill with the rule's name.
   */
  allocatedEntityName?: string;
  /** Resolved GL account code of the contra line (absent if the journal is gone). */
  allocatedAccountCode?: string;
  /** Resolved GL account name of the contra line. */
  allocatedAccountName?: string;
  /** Name of the categorisation rule that auto-posted this row, if any. */
  allocationRuleName?: string;
  /** Id of the categorisation rule that auto-posted this row, if any. */
  allocationRuleId?: string;
  /**
   * Supplier / customer / transfer counterparty label as stored at allocation
   * time. Kept separate from the account so one column never carries two
   * different kinds of value again.
   */
  allocatedCounterpartyName?: string;
  /** For allocationType = 'transfer': the GL account id of the other bank account. */
  counterpartyAccountId?: string;
  /** For allocationType = 'transfer': the single balanced JE id shared by both legs. */
  transferJournalEntryId?: string;
}

// ── Bank Reconciliation ──────────────────────────────────────────────────────

export interface BankReconciliation {
  id: string;
  bankAccountId: string;
  statementDate: string;
  statementBalance: number;
  glBalance: number;
  reconciledBalance: number;
  difference: number;
  status: BankReconStatus;
  startedBy: string;
  startedAt: string;
  completedBy?: string;
  completedAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  bankAccountName?: string;
  matchedCount?: number;
  unmatchedCount?: number;
  groupId?: string;
  groupName?: string;
}

// ── Auto-Match ───────────────────────────────────────────────────────────────

export interface AutoMatchCandidate {
  bankTransactionId: string;
  journalLineId: string;
  confidence: number; // 0-1
  matchReason: 'exact_reference' | 'amount_date' | 'amount_only' | 'rule_match';
}

export interface AutoMatchResult {
  matched: number;
  unmatched: number;
  candidates: AutoMatchCandidate[];
  /**
   * High-confidence matches that were NOT applied because the transaction had
   * been allocated by another request in between. Counted rather than fatal:
   * one raced row must not abort the rest of the run, and it must not vanish
   * either — the user sees a lower `matched` and needs to know why.
   */
  skippedRaced?: number;
  /**
   * High-confidence matches that were NOT applied because `bank_transactions`
   * was locked at the table level — DDL, a migration's index build. Counted
   * apart from `skippedRaced`: nothing is known about those rows, so calling
   * them "allocated by another request" would be a false claim.
   */
  skippedUnavailable?: number;
}

// ── Bank Categorisation Rules ───────────────────────────────────────────────

export type RuleMatchField = 'description' | 'reference' | 'both';
export type RuleMatchType = 'contains' | 'starts_with' | 'ends_with' | 'exact';

export type RuleVatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

export interface BankCategorisationRule {
  id: string;
  ruleName: string;
  matchField: RuleMatchField;
  matchType: RuleMatchType;
  matchPattern: string;
  glAccountId?: string;
  supplierId?: string;
  clientId?: string;
  descriptionTemplate?: string;
  priority: number;
  isActive: boolean;
  autoCreateEntry: boolean;
  vatCode: RuleVatCode;
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  // Joined
  glAccountCode?: string;
  glAccountName?: string;
  supplierName?: string;
  clientName?: string;
  cc1Name?: string;
  cc2Name?: string;
  buName?: string;
}

export interface RuleCreateInput {
  ruleName: string;
  matchField: RuleMatchField;
  matchType: RuleMatchType;
  matchPattern: string;
  glAccountId?: string;
  supplierId?: string;
  clientId?: string;
  descriptionTemplate?: string;
  priority?: number;
  autoCreateEntry?: boolean;
  vatCode?: RuleVatCode;
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

export interface RuleApplyResult {
  applied: number;
  skipped: number;
  entries: Array<{ bankTxId: string; ruleName: string; journalEntryId?: string; suggestion?: boolean }>;
  /**
   * Number of active auto-post rules that were skipped because the bank
   * account has no linked GL account. When > 0 the UI must surface this
   * loudly — the user expects auto-post to fire and silent skipping is the
   * single most common cause of "rules aren't working" support reports.
   */
  autoPostRulesSkippedNoBankGl?: number;
  /**
   * Number of auto-post attempts that failed because the transaction date
   * falls in a closed/locked fiscal period. We swallow per-tx and count so
   * one historical date doesn't abort the whole apply.
   */
  autoPostSkippedClosedPeriod?: number;
  /**
   * Number of auto-post attempts skipped because no fiscal_periods row covers
   * the transaction date — the fiscal year hasn't been created. Reported
   * separately from `autoPostSkippedClosedPeriod` so the UI can prompt the
   * user to create the missing year (different remedy than re-opening).
   */
  autoPostSkippedNoPeriod?: number;
  /**
   * Number of auto-post attempts skipped because the transaction had been
   * allocated (or otherwise moved off `imported`) by another request between
   * the rule's candidate query and the row lock. Counted rather than silently
   * dropped: a rule run that quietly did less than it matched is exactly the
   * kind of thing that reads as "rules aren't working".
   */
  autoPostSkippedRaced?: number;
  /**
   * Number of lines this sweep posted GROSS because the rule asked to claim
   * input tax against an account flagged `vat_input_denied` (s17(2)(a)
   * entertainment). The line still posts — only the claim is dropped. Reported
   * because a rule set to claim on an entertainment account is a configuration
   * mistake, and leaving it silent is how R43,008.01 accumulated unnoticed.
   */
  autoPostVatDenied?: number;
  /**
   * Number of lines this sweep posted GROSS because the rule asked to claim
   * VAT against an account on which NO SUPPLY CAN ARISE — salaries, statutory
   * deductions, taxes, distributions, depreciation, donations, exempt
   * financial services. A different statute from `autoPostVatDenied` above:
   * there a supply happened and the claim is refused, here nothing was
   * supplied at all. Reported for the same reason: R400,388.14 of input tax
   * accumulated on Velocity's salary account unnoticed, and R237,021.60 again
   * when the ledger was rebuilt.
   */
  autoPostNonSupply?: number;
  /**
   * Number of auto-post attempts skipped because another request held the
   * transaction's row lock for longer than the 5s timeout. Retryable: nothing
   * was posted for these, and a re-run picks them up.
   */
  autoPostSkippedLocked?: number;
  /**
   * Number of RULES whose candidate set hit the 500-row cap, so this run left
   * matching transactions unprocessed. Deliberately a rule count and not a row
   * count — knowing how many were left over would mean a COUNT over the whole
   * table for a number nobody acts on. Non-zero means "re-run to continue".
   */
  autoPostTruncatedRules?: number;
}
