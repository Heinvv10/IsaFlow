/**
 * PRD-060: FibreFlow Accounting Module
 * Bank Reconciliation Type Definitions
 */

export type BankTxStatus = 'imported' | 'allocated' | 'matched' | 'reconciled' | 'excluded';
/**
 * Bank feed lifecycle state (migration 675). A row is `pending` or `removed`
 * at the bank until the provider posts it; declared here (types must not
 * depend on services) and re-exported by `services/bank/bankFeedStateGuard`.
 */
export type FeedState = 'pending' | 'posted' | 'removed';
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
  feedState: FeedState;
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
  /** The asset / fleet record this line is annotated with (mig 853) — never a posting. */
  link?: BankTxLink;
}

export type BankTxLinkKind = 'asset' | 'fuel' | 'service';

/** An asset / fleet LINK on a bank line: an annotation only — it never changes status, journal or stamp. */
export interface BankTxLink {
  kind: BankTxLinkKind;
  /** The asset, fuel record or service record id. */
  id: string;
  assetId?: string;
  assetName?: string;
  /** Asset name / "Fuel 2026-10-01 R850.00" / the service description. */
  label: string;
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
  /** Candidates refused for a typed state of their own (a reversed or missing journal line): skipped, counted. */
  skippedRefused?: number;
  /** Step 2: the run's own person imported the line AND created the journal, under manual_journal enforcement. */
  skippedImporter?: number;
}

// ── Bank Categorisation Rules ───────────────────────────────────────────────

export type RuleMatchField = 'description' | 'reference' | 'both';
export type RuleMatchType = 'contains' | 'starts_with' | 'ends_with' | 'exact';

export type RuleVatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

import type { AutoApplyMode } from '../services/shared/autoAllocateStrategy';

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
  /**
   * What an auto-posted supplier/customer line does with its cash (migration
   * 676): 'fifo' applies it to the contact's oldest open documents, 'none'
   * leaves it on account. Unattended, there is no caller to ask.
   */
  autoApply: AutoApplyMode;
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
  autoApply?: AutoApplyMode;
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

export type { RuleApplyResult } from './bank-rule-apply.types';
