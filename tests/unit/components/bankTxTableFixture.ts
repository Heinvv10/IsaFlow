/**
 * Shared fixture for the BankTxTable naming and callback tests: one row in each state the grid draws
 * (suggested account with an entertainment VAT warning, customer, pending feed, allocated, reconciled,
 * excluded) and a props factory with every optional handler wired to a spy.
 */
import { vi } from 'vitest';
import type { BankTx, BankTxTableProps, RowSelection, SelectOption } from '@/components/accounting/bankTx/bankTxTypes';

export const TXS: BankTx[] = [
  { id: 'a', description: 'WOOLWORTHS FOOD', amount: -100.5, transactionDate: '2026-06-01', status: 'imported', suggestedGlAccountId: 'g1', suggestedGlAccountName: 'Entertainment', suggestedGlAccountCode: '6100', suggestedConfidence: 0.9, notes: 'lunch' },
  { id: 'b', description: 'Pending row', amount: -50, transactionDate: '2026-06-02', status: 'imported', feedState: 'pending' },
  { id: 'c', description: 'Client pay', amount: 500, transactionDate: '2026-06-03', status: 'imported', suggestedClientId: 'c1', suggestedClientName: 'Acme' },
  { id: 'n', description: 'Unallocated', amount: -7, transactionDate: '2026-06-03', status: 'imported' },
  { id: 'd', description: 'Posted', amount: -20, transactionDate: '2026-06-04', status: 'allocated', allocationType: 'account', allocatedAccountCode: '6100', allocatedAccountName: 'Ent', postedVatCode: 'standard', postedVatAmount: 2.6 },
  { id: 'e', description: 'Recon', amount: 30, transactionDate: '2026-06-05', status: 'reconciled', needsEvidence: true, provisionalJeId: 'j' },
  { id: 'f', description: 'Excl', amount: 30, transactionDate: '2026-06-05', status: 'excluded', excludeReason: 'dup' },
];

export const GL: SelectOption[] = [
  { id: 'g1', code: '6100', name: 'Entertainment', vatInputDenied: true },
  { id: 'g2', code: '7000', name: 'Donations' },
];

export const SELECTIONS: Record<string, RowSelection> = {
  a: { type: 'account', entityId: 'g1', label: '6100 Entertainment', vatCode: 'standard', cc1Id: 'x', cc2Id: '', buId: '' },
  c: { type: 'customer', entityId: 'c1', label: 'Acme', vatCode: 'none' },
};

export function tableProps(over: Partial<BankTxTableProps> = {}): BankTxTableProps {
  return {
    transactions: TXS, glAccounts: GL,
    suppliers: [{ id: 's1', name: 'Sup' }], customers: [{ id: 'c1', name: 'Acme' }], transferTargets: [{ id: 't1', code: '8400', name: 'FNB' }],
    cc1Options: [{ id: 'x', code: 'X', name: 'Xn' }], cc2Options: [{ id: 'y', name: 'Y' }], buOptions: [{ id: 'z', name: 'Z' }],
    showCC: true, showBU: true,
    selectedIds: new Set<string>(), rowSelections: SELECTIONS, allSelected: false, tab: 'new',
    onToggleSelect: vi.fn(), onSelectAll: vi.fn(), onRowTypeChange: vi.fn(), onRowEntityChange: vi.fn(),
    onRowVatChange: vi.fn(), onRowDimensionChange: vi.fn(),
    onAccept: vi.fn(), onExclude: vi.fn(), onUnmatch: vi.fn(), onSplit: vi.fn(), onUpdateNotes: vi.fn(),
    onFindMatch: vi.fn(), onReverse: vi.fn(), onAttachments: vi.fn(), onAskClient: vi.fn(), onCreateRule: vi.fn(),
    onCreateEntity: vi.fn(), onLink: vi.fn(),
    ...over,
  };
}
