// The transfer link log drawer (migration 978): batch headers per source, the undone stamp, and Undo controls only
// where a live link exists and the role may write.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TransferLinkLogDrawer, type TransferLinkLogDrawerProps } from '@/components/accounting/bank-transactions/TransferLinkLogDrawer';
import type { TransferLinkBatch } from '@/modules/accounting/services/bank/bankTransferLinkLog';

const batches: TransferLinkBatch[] = [
  {
    batchId: 'b1', source: 'page_load', linkedAt: '2026-11-12T08:15:00.000Z', activeCount: 2, links: [
      { id: 'l1', bankTransactionId: 't1', transactionDate: '2026-11-10', description: 'Transfer to savings', amount: 1500,
        counterpartyAccountName: 'Savings', state: 'linked', undoneAt: null },
      { id: 'l2', bankTransactionId: 't2', transactionDate: '2026-11-11', description: null, amount: 20,
        counterpartyAccountName: null, state: 'linked', undoneAt: null },
    ],
  },
  {
    batchId: 'b2', source: 'import', linkedAt: '2026-11-01T10:00:00.000Z', activeCount: 0, links: [
      { id: 'l3', bankTransactionId: 't3', transactionDate: '2026-10-31', description: 'Inter-account transfer', amount: 10,
        counterpartyAccountName: 'Call', state: 'undone', undoneAt: '2026-11-02T10:00:00.000Z' },
    ],
  },
];

function mount(over: Partial<TransferLinkLogDrawerProps> = {}) {
  const props: TransferLinkLogDrawerProps = {
    open: true, onClose: vi.fn(), batches, canUndo: true, busyId: null, onUndoBatch: vi.fn(), onUndoLink: vi.fn(),
    error: null, ...over,
  };
  render(<TransferLinkLogDrawer {...props} />);
  return props;
}

describe('TransferLinkLogDrawer', () => {
  it('says which links it covers: page load and statement import, not a transfer the user allocates', () => {
    mount();
    expect(screen.getByText(/when you opened Bank Transactions or imported a statement\./)).toBeInTheDocument();
  });

  it('heads each batch with its source, and counts or marks it all undone', () => {
    mount();
    expect(screen.getByText(/· Opened Bank Transactions$/)).toBeInTheDocument();
    expect(screen.getByText(/· Statement import$/)).toBeInTheDocument();
    expect(screen.getByText('2 lines linked')).toBeInTheDocument();
    expect(screen.getByText('All undone')).toBeInTheDocument();
    expect(screen.getByText(/^Undone 02 Nov 2026/)).toBeInTheDocument();
    expect(screen.getByText(/Linked to a transfer with Savings/)).toBeInTheDocument();
    expect(screen.getByText(/Linked to a transfer on another account/)).toBeInTheDocument();
  });

  it('offers Undo all only on a batch with live links, and names each line Undo', () => {
    const props = mount();
    const undoAll = screen.getAllByRole('button', { name: 'Undo all' });
    expect(undoAll).toHaveLength(1);
    fireEvent.click(undoAll[0]);
    expect(props.onUndoBatch).toHaveBeenCalledWith('b1');
    fireEvent.click(screen.getByRole('button', { name: 'Undo link for Transfer to savings' }));
    expect(props.onUndoLink).toHaveBeenCalledWith('l1');
    expect(screen.getByRole('button', { name: 'Undo link for this line' })).toBeInTheDocument();
    const imported = screen.getByRole('region', { name: /Statement import/ });
    expect(within(imported).queryByRole('button')).not.toBeInTheDocument();
  });

  it('disables the buttons while an undo runs', () => {
    mount({ busyId: 'b1' });
    expect(screen.getByRole('button', { name: 'Undoing...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Undo link for Transfer to savings' })).toBeDisabled();
  });

  it('shows no Undo to a role that may not write', () => {
    mount({ canUndo: false });
    expect(screen.queryByRole('button', { name: /Undo/ })).not.toBeInTheDocument();
  });

  it('counts a partly undone batch as "n of m" and shows a changed line without an Undo', () => {
    const mixed: TransferLinkBatch = {
      batchId: 'b3', source: 'page_load', linkedAt: '2026-11-12T08:15:00.000Z', activeCount: 1, links: [
        { ...batches[0].links[0] },
        { ...batches[0].links[1], state: 'undone', undoneAt: '2026-11-12T09:00:00.000Z' },
        { ...batches[0].links[1], id: 'l4', description: 'Reversed later', state: 'changed' },
      ],
    };
    mount({ batches: [mixed] });
    expect(screen.getByText('1 of 3 lines still linked')).toBeInTheDocument();
    expect(screen.getByText('Changed since the link')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo link for Reversed later' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Undo link for/ })).toHaveLength(1);
  });

  it('notes the cap when the latest runs fill it', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...batches[1], batchId: `x${i}` }));
    mount({ batches: many });
    expect(screen.getByText('Showing the latest 50 runs.')).toBeInTheDocument();
  });

  it('says so when the account has no automatic links, and shows an error', () => {
    mount({ batches: [], error: 'This line has changed since it was linked, so the link was not undone.' });
    expect(screen.getByText('No transfers have been linked automatically on this account in the last 90 days.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('This line has changed since it was linked');
  });
});
