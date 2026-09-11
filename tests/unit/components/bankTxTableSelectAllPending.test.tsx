/**
 * Select-all must skip pending feed rows — there is nothing actionable to
 * select on a row the bank hasn't posted yet. This wraps BankTxTable the way
 * pages/accounting/bank-transactions/index.tsx does: `allSelected` and
 * `onSelectAll` are derived from `actionableIds`, not from every visible row.
 *
 * Rendered, not grepped: the header checkbox's onChange and its resulting
 * selection are conditionals only a real click exercises.
 */
import { describe, it, expect } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { BankTxTable, type BankTx } from '@/components/accounting/BankTxTable';
import { actionableIds } from '@/components/accounting/bank-transactions/pendingFeedRow';

const TXS: BankTx[] = [
  { id: 'posted-1', description: 'Posted row', amount: -100, transactionDate: '2026-06-01', status: 'imported', feedState: 'posted' },
  { id: 'pending-1', description: 'Pending row', amount: -50, transactionDate: '2026-06-02', status: 'imported', feedState: 'pending' },
];

function Harness({ transactions }: { transactions: BankTx[] }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectableTxIds = actionableIds(transactions, transactions.map(t => t.id));
  const allSelected = selectableTxIds.length > 0 && selectableTxIds.every(id => selectedIds.has(id));
  return (
    <>
      <div data-testid="selected">{Array.from(selectedIds).sort().join(',')}</div>
      <BankTxTable
        transactions={transactions}
        glAccounts={[]} suppliers={[]} customers={[]} transferTargets={[]}
        cc1Options={[]} cc2Options={[]} buOptions={[]}
        selectedIds={selectedIds}
        rowSelections={{}}
        allSelected={allSelected}
        tab="new"
        onToggleSelect={(id) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; })}
        onSelectAll={() => setSelectedIds(allSelected ? new Set() : new Set(selectableTxIds))}
        onRowTypeChange={() => {}} onRowEntityChange={() => {}} onRowVatChange={() => {}}
        onRowDimensionChange={() => {}}
        onAccept={() => {}} onExclude={() => {}} onUnmatch={() => {}} onSplit={() => {}}
      />
    </>
  );
}

describe('BankTxTable select-all skips pending rows', () => {
  it('selects only the posted id when rows are [posted, pending]', () => {
    render(<Harness transactions={TXS} />);
    const headerCheckbox = screen.getAllByRole('checkbox')[0];
    fireEvent.click(headerCheckbox);
    expect(screen.getByTestId('selected').textContent).toBe('posted-1');
  });

  it('disables the header checkbox when every visible row is pending', () => {
    render(<Harness transactions={[TXS[1]!]} />);
    const headerCheckbox = screen.getAllByRole('checkbox')[0];
    expect(headerCheckbox).toBeDisabled();
  });
});
