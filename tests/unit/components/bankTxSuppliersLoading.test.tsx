// While the bank page's supplier list pages in, an empty supplier dropdown must
// say "Loading", not "No results found" (PUR-01 round 4). A row already
// allocated to a supplier shows the name the server returned, not a list lookup.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { BankTxTable, type BankTx, type RowSelection } from '@/components/accounting/BankTxTable';
import { BankTxBatchPanel } from '@/components/accounting/bank-transactions/BankTxBatchPanel';
import { BankTxSuppliersNotice } from '@/components/accounting/bank-transactions/BankTxSuppliersNotice';

const TX: BankTx = { id: 't1', description: 'Row', amount: -100, transactionDate: '2026-06-01', status: 'imported', feedState: 'posted' };

function table(suppliersLoading: boolean, sel: RowSelection) {
  return render(
    <BankTxTable
      transactions={[TX]} glAccounts={[]} suppliers={[]} suppliersLoading={suppliersLoading} customers={[]} transferTargets={[]}
      cc1Options={[]} cc2Options={[]} buOptions={[]} selectedIds={new Set()} rowSelections={{ t1: sel }}
      allSelected={false} tab="new" onToggleSelect={vi.fn()} onSelectAll={vi.fn()}
      onRowTypeChange={vi.fn()} onRowEntityChange={vi.fn()} onRowVatChange={vi.fn()} onRowDimensionChange={vi.fn()}
      onAccept={vi.fn()} onExclude={vi.fn()} onUnmatch={vi.fn()} onSplit={vi.fn()}
    />,
  );
}
const open = { type: 'supplier' as const, entityId: '', label: '', vatCode: 'none' as const };

describe('bank page supplier list loading state', () => {
  it('row dropdown says Loading while suppliers load', () => {
    table(true, open);
    fireEvent.click(screen.getByText('Select Supplier'));
    expect(screen.getByText('Loading suppliers…')).toBeTruthy();
    expect(screen.queryByText('No results found')).toBeNull();
  });
  it('row dropdown says No results once loaded and empty', () => {
    table(false, open);
    fireEvent.click(screen.getByText('Select Supplier'));
    expect(screen.getByText('No results found')).toBeTruthy();
  });
  it('an allocated supplier row keeps its label while the list is empty', () => {
    table(true, { ...open, entityId: 'sup-9', label: 'Acme Traders' });
    expect(screen.getByText('Acme Traders')).toBeTruthy();
  });
  it('batch panel says Loading for suppliers only', () => {
    const props = {
      showBatchEdit: true, selectedCount: 2, batchSearch: '', glAccounts: [], suppliers: [], suppliersLoading: true,
      customers: [], transferTargets: [], rulePrompt: null, onBatchTypeChange: vi.fn(), onBatchSearchChange: vi.fn(),
      onApplyBatchEdit: vi.fn(), onCancelBatchEdit: vi.fn(), onCreateRule: vi.fn(), onDismissRulePrompt: vi.fn(),
    };
    const { rerender } = render(<BankTxBatchPanel {...props} batchType="supplier" />);
    expect(screen.getByText('Loading suppliers…')).toBeTruthy();
    rerender(<BankTxBatchPanel {...props} batchType="customer" />);
    expect(screen.getByText('No results found')).toBeTruthy();
  });
  it('notice renders only for failed and truncated', () => {
    const { container, rerender } = render(<BankTxSuppliersNotice status="loading" />);
    expect(container.textContent).toBe('');
    rerender(<BankTxSuppliersNotice status="ok" />);
    expect(container.textContent).toBe('');
    rerender(<BankTxSuppliersNotice status="failed" />);
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load/);
    rerender(<BankTxSuppliersNotice status="truncated" />);
    expect(screen.getByRole('status').textContent).toMatch(/first 10\s000 suppliers/);
  });
});
