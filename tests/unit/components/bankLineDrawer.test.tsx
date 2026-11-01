/**
 * Master plan U (M10): the bank line drawer. Row data, attachments and the matched journal, each read on its own, so
 * one failed read cannot pass for "none". The row's Details button must not reach the grid's Enter-to-accept hotkey:
 * that would post a journal from a key meant to open a panel.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { BankLineDrawerBody } from '@/components/accounting/bank-transactions/BankLineDrawerBody';
import { BankTxListFrame } from '@/components/accounting/bank-transactions/BankTxListFrame';
import { BankTxTable, type BankTx } from '@/components/accounting/BankTxTable';

useApiJsonOverMock();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (message: string) => json({ success: false, error: { code: 'E', message } }, 500);

const TX: BankTx = {
  id: 'tx-1', transactionDate: '2026-06-01', description: 'WOOLWORTHS', reference: 'REF-9', amount: -115, status: 'allocated',
  allocatedEntityName: '5000 Fuel', matchedJournalEntryId: 'je-1',
};
const JOURNAL = {
  id: 'je-1', entryNumber: 'JE-0042', entryDate: '2026-06-01', status: 'posted',
  lines: [
    { id: 'l1', accountCode: '1110', accountName: 'Bank', debit: 0, credit: 115 },
    { id: 'l2', accountCode: '5000', accountName: 'Fuel', debit: 115, credit: 0 },
  ],
};
const ATTACHMENTS = [
  { id: 'a1', file_name: 'slip.pdf', file_url: 'https://files.example/slip.pdf' },
  { id: 'a2', file_name: 'evil.html', file_url: 'data:text/html;base64,PHNjcmlwdD4=' },
];
function serve(attachments: () => Response = () => ok(ATTACHMENTS), journal: () => Response = () => ok(JOURNAL)) {
  vi.mocked(apiFetch).mockImplementation(async (url) => (String(url).includes('bank-tx-attachments') ? attachments() : journal()));
}
const urls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

describe('BankLineDrawerBody', () => {
  it('shows the row, its attachments and its matched journal', async () => {
    serve();
    render(<BankLineDrawerBody tx={TX} />);
    expect(screen.getByText('WOOLWORTHS')).toBeTruthy();
    expect(screen.getByText('REF-9')).toBeTruthy();
    expect(screen.getByText('5000 Fuel')).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'slip.pdf' })).getAttribute('href')).toBe('https://files.example/slip.pdf');
    const journal = await screen.findByRole('link', { name: 'JE-0042' });
    expect(journal.getAttribute('href')).toBe('/accounting/journal-entries/je-1');
    expect(screen.getByText('1110 Bank')).toBeTruthy();
    expect(screen.getByText('5000 Fuel', { selector: 'td' })).toBeTruthy();
    expect(urls()).toContain('/api/accounting/journal-entries-detail?id=je-1');
    expect(urls()).toContain('/api/accounting/bank-tx-attachments?bankTransactionId=tx-1');
  });

  it('never hyperlinks an attachment the shared allowlist refuses', async () => {
    serve();
    render(<BankLineDrawerBody tx={TX} />);
    expect(await screen.findByText('evil.html')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'evil.html' })).toBeNull();
  });

  it('a line with no journal reads none and asks for none', async () => {
    serve();
    const { matchedJournalEntryId: _, ...unmatched } = TX;
    render(<BankLineDrawerBody tx={{ ...unmatched, status: 'imported' }} />);
    expect(await screen.findByText('Not matched to a journal.')).toBeTruthy();
    expect(urls().some((u) => u.includes('journal-entries-detail'))).toBe(false);
  });

  it('a failed attachments read says so, and is not "no attachments"', async () => {
    serve(() => refuse('Attachments are unavailable'));
    render(<BankLineDrawerBody tx={TX} />);
    expect(await screen.findByText('Attachments are unavailable')).toBeTruthy();
    expect(screen.queryByText('No attachments.')).toBeNull();
    expect(await screen.findByRole('link', { name: 'JE-0042' })).toBeTruthy();
  });

  it('a failed journal read says so', async () => {
    serve(undefined, () => refuse('The journal is unavailable'));
    render(<BankLineDrawerBody tx={TX} />);
    expect(await screen.findByText('The journal is unavailable')).toBeTruthy();
  });

  it('shows the exclusion reason on an excluded line, and ignores the one left on a restored line', async () => {
    serve();
    const { rerender } = render(<BankLineDrawerBody tx={{ ...TX, status: 'excluded', excludeReason: 'Duplicate' }} />);
    expect(screen.getByText('Duplicate')).toBeTruthy();
    rerender(<BankLineDrawerBody tx={{ ...TX, status: 'imported', excludeReason: 'Duplicate' }} />);
    expect(screen.queryByText('Duplicate')).toBeNull();
    await screen.findByRole('link', { name: 'JE-0042' });
  });
});

describe('BankTxListFrame', () => {
  it('mounts the drawer for the open line and closes through onDetailClose', async () => {
    serve();
    const onDetailClose = vi.fn();
    render(
      <BankTxListFrame relinkFailed={false} aiPolling={0} isLoading={false} error="" empty={false} pastEnd={false} tab="new"
        detailTx={TX} onDetailClose={onDetailClose}>
        <table />
      </BankTxListFrame>,
    );
    expect(screen.getByRole('dialog', { name: 'Bank line' })).toBeTruthy();
    await screen.findByRole('link', { name: 'JE-0042' });
    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
    expect(onDetailClose).toHaveBeenCalledTimes(1);
  });
});

describe('the row\'s Details button', () => {
  function table(onAccept = vi.fn(), onOpenDetails = vi.fn()) {
    const tx: BankTx = { ...TX, status: 'imported' };
    render(
      <BankTxTable transactions={[tx]} glAccounts={[]} suppliers={[]} customers={[]} transferTargets={[]} cc1Options={[]} cc2Options={[]} buOptions={[]}
        selectedIds={new Set()} rowSelections={{ [tx.id]: { type: 'account', entityId: 'gl-1', label: 'Fuel', vatCode: 'none' } }}
        allSelected={false} tab="new" onToggleSelect={vi.fn()} onSelectAll={vi.fn()} onRowTypeChange={vi.fn()} onRowEntityChange={vi.fn()}
        onRowVatChange={vi.fn()} onRowDimensionChange={vi.fn()} onAccept={onAccept} onExclude={vi.fn()} onUnmatch={vi.fn()} onSplit={vi.fn()}
        onOpenDetails={onOpenDetails} />,
    );
    return { onAccept, onOpenDetails, tx, button: screen.getByRole('button', { name: /^Details, / }) };
  }

  it('opens the drawer for its line', () => {
    const { button, onOpenDetails, tx } = table();
    fireEvent.click(button);
    expect(onOpenDetails).toHaveBeenCalledWith(tx.id);
  });

  it('Enter on it does not accept the row', () => {
    const { button, onAccept } = table();
    fireEvent.click(button.closest('tr')!); // the grid now has a focused row: Enter there accepts
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('names the line, and keeps the words it shows in that name', () => {
    const { button } = table();
    expect(button.getAttribute('aria-label')).toContain('WOOLWORTHS');
    expect(button.textContent).toContain('WOOLWORTHS');
  });
});
