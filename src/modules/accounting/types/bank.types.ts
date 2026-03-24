/**
 * PRD-060: FibreFlow Accounting Module
 * Bank Reconciliation Type Definitions
 */

export type BankTxStatus = 'imported' | 'allocated' | 'matched' | 'reconciled' | 'excluded';
export type BankReconStatus = 'in_progress' | 'completed';
export type BankFormat = 'fnb' | 'standard_bank' | 'nedbank' | 'absa' | 'capitec' | 'ofx' | 'qif' | 'unknown';

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
  // Allocation tracking — populated when status is matched/reconciled
  allocationType?: 'account' | 'supplier' | 'customer';
  allocatedEntityName?: string;
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
}
