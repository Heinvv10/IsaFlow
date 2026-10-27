/**
 * Bank transaction table types and the VAT option list, shared by BankTxTable and its row cells.
 */

import type { BankTxLink } from '@/modules/accounting/types/bank.types';

export type AllocType = 'account' | 'supplier' | 'customer' | 'transfer';
export type VatCode = 'none' | 'standard' | 'zero_rated' | 'exempt';

export const VAT_OPTIONS: { value: VatCode; label: string; rate: number }[] = [
  { value: 'none', label: 'No VAT', rate: 0 },
  { value: 'standard', label: 'Standard 15%', rate: 15 },
  { value: 'zero_rated', label: 'Zero Rated', rate: 0 },
  { value: 'exempt', label: 'Exempt', rate: 0 },
];

export interface BankTx {
  id: string;
  transactionDate: string;
  description?: string;
  reference?: string;
  bankReference?: string;
  amount: number;
  status: string;
  /** Feed ingestion state — a 'pending' row has not posted at the bank yet and is read-only. */
  feedState?: 'pending' | 'posted' | 'removed';
  /** Reason recorded when this transaction was excluded */
  excludeReason?: string;
  /** User-editable memo field from bank_transactions.notes */
  notes?: string;
  /** Suggestion fields — populated by rules or classified import */
  suggestedGlAccountId?: string;
  suggestedGlAccountName?: string;
  suggestedGlAccountCode?: string;
  suggestedSupplierId?: string;
  suggestedSupplierName?: string;
  suggestedClientId?: string;
  suggestedClientName?: string;
  suggestedCategory?: string;
  suggestedVatCode?: string;
  /** Smart categorization confidence score (0-1) */
  suggestedConfidence?: number;
  /** Dimension fields */
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
  cc1Name?: string;
  cc2Name?: string;
  cc1Code?: string;
  cc2Code?: string;
  buCode?: string;
  dimensionSource?: 'bank' | 'journal' | 'split';
  buName?: string;
  /** Allocation tracking — populated for matched/reconciled transactions */
  allocationType?: AllocType;
  /** Resolved from the posted journal: "<code> <account name>". */
  allocatedEntityName?: string;
  allocatedAccountCode?: string;
  allocatedAccountName?: string;
  /** Name of the categorisation rule that auto-posted this row, if any. */
  allocationRuleName?: string;
  /** Supplier / customer / transfer counterparty recorded at allocation time. */
  allocatedCounterpartyName?: string;
  /** PRD-05 Phase 5: provisional journal entry id (status = 'provisional') */
  provisionalJeId?: string | null;
  /** PRD-05 Phase 5: true when the provisional JE has no attached evidence yet */
  needsEvidence?: boolean;
  /** LLM tier: categorization strategy used ('llm' | 'rule' | 'history' | ...) */
  suggestedStrategy?: string;
  /**
   * VAT treatment read back off the POSTED JOURNAL. For an allocated row this
   * is the only truthful source: the suggestion columns this table used to read
   * are cleared at allocation time, so every rule-posted row rendered "No VAT"
   * over a journal that had claimed input tax at 15%.
   */
  postedVatCode?: VatCode;
  /** Input/output tax actually posted, in rands. */
  postedVatAmount?: number;
  /** Asset / fuel / service record this line is annotated with (an annotation — never a posting). */
  link?: BankTxLink;
}

export interface SelectOption {
  id: string;
  code?: string;
  name: string;
  defaultVatCode?: string;
  /** VAT Act s17(2)(a): claiming input tax here warrants a warning. */
  vatInputDenied?: boolean;
}

export interface RowSelection {
  type: AllocType;
  entityId: string;
  label: string;
  vatCode: VatCode;
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

export interface BankTxTableProps {
  transactions: BankTx[];
  glAccounts: SelectOption[];
  suppliers: SelectOption[];
  /** The supplier list is still paging in: an empty supplier dropdown is not "no results" yet. */
  suppliersLoading?: boolean;
  customers: SelectOption[];
  /** Other bank GL accounts available as transfer targets (source bank already excluded). */
  transferTargets: SelectOption[];
  cc1Options: SelectOption[];
  cc2Options: SelectOption[];
  buOptions: SelectOption[];
  showCC?: boolean;
  showBU?: boolean;
  selectedIds: Set<string>;
  rowSelections: Record<string, RowSelection>;
  allSelected: boolean;
  tab: 'new' | 'reviewed' | 'excluded';
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onRowTypeChange: (txId: string, type: AllocType) => void;
  onRowEntityChange: (txId: string, entityId: string, label: string) => void;
  onRowVatChange: (txId: string, vatCode: VatCode) => void;
  onRowDimensionChange: (txId: string, cc1Id: string, cc2Id: string, buId: string) => void;
  onAccept: (txId: string) => void;
  onExclude: (txId: string) => void;
  onUnmatch: (txId: string) => void;
  onSplit: (txId: string) => void;
  /** Called when the user finishes editing the notes field for a row */
  onUpdateNotes?: (txId: string, notes: string) => void;
  onFindMatch?: (txId: string) => void;
  onReverse?: (txId: string) => void;
  onAttachments?: (txId: string) => void;
  onAskClient?: (txId: string) => void;
  onCreateRule?: (tx: BankTx) => void;
  onCreateEntity?: (txId: string, type: AllocType) => void;
  /** Open the asset / fuel / service link picker for a row. */
  onLink?: (tx: BankTx) => void;
}
