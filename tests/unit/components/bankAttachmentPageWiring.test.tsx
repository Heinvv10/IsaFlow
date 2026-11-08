/**
 * The join between the pages and the attachments modal, with the real table, row button, modal and viewer: a highlighted
 * paperclip opens the viewer, a plain one opens the list, and the row's count follows a remove without a reload. Each
 * half is tested alone elsewhere with its props passed by hand, so deleting a prop here would otherwise stay green.
 */
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, pathname: '/', asPath: '/', push: vi.fn(), replace: vi.fn(), isReady: true, events: { on: vi.fn(), off: vi.fn() } }) }));
vi.mock('next/dynamic', async () => {
  const { BankTxAttachmentsModal } = await import('@/components/accounting/BankTxAttachmentsModal');
  return { default: () => BankTxAttachmentsModal };
});
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/bank-transactions/useBankTxRefData', () => ({
  useBankTxRefData: (s: { setBankAccounts: (v: unknown[]) => void; setSelectedBank: (f: () => string) => void; setRefDataLoaded: (v: boolean) => void }) => {
    useEffect(() => { s.setBankAccounts([{ id: 'b1', accountCode: '1100', accountName: 'Bank' }]); s.setSelectedBank(() => 'b1'); s.setRefDataLoaded(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return { refreshBankAccounts: vi.fn() };
  },
}));
vi.mock('@/components/accounting/bank-transactions/useBankTxActions', () => ({ buildBankTxActions: () => ({}) }));
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({ BankTxBankCards: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxFilters', () => ({ BankTxFilters: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxBatchPanel', () => ({ BankTxBatchPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxSuppliersNotice', () => ({ BankTxSuppliersNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/AutoPostRunsPanel', () => ({ AutoPostRunsPanel: () => null }));
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => null }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';
import QueriesPage from '../../../pages/accounting/bank/queries';

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const file = (id: string, name: string) => ({ id, bank_transaction_id: 't1', file_name: name, file_url: 'data:image/png;base64,iVBORw0KGgo=', file_size: 8, uploaded_by: null, created_at: '2026-06-01' });
const row = (id: string, description: string, attachmentCount: number) => ({ id, transactionDate: '2026-01-01', description, amount: -5, status: 'imported', attachmentCount });

function serve(files: ReturnType<typeof file>[]) {
  let stored = files;
  vi.mocked(apiFetch).mockImplementation(async (u, init) => {
    const url = String(u);
    if (url.includes('bank-tx-attachments')) {
      if (init?.method === 'DELETE') { stored = stored.filter(f => !url.includes(f.id)); return ok({ deleted: true }); }
      return ok(stored);
    }
    if (url.includes('/api/accounting/bank-tx-queries')) {
      return ok([{ id: 'q1', bank_transaction_id: 't1', status: 'replied', tx_description: 'WOOLWORTHS', amount: -5, transaction_date: '2026-01-01', attachment_count: stored.length, to_number: '27', message_body: 'm' }]);
    }
    if (url.includes('/api/accounting/bank-transactions?')) {
      return ok({ transactions: [row('t1', 'WITH FILES', stored.length), row('t2', 'NO FILES', 0)], total: 2 });
    }
    return ok({});
  });
}

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test/1');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the bank transactions page', () => {
  it('opens the viewer from a highlighted paperclip', async () => {
    serve([file('a1', 'slip.png'), file('a2', 'two.png')]);
    render(<BankTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^2 attachments - view, .*WITH FILES/ }));
    expect(await screen.findByRole('dialog', { name: 'Attachment preview' })).toBeTruthy();
    // The image is set from an effect (blob URL) after the dialog mounts, so it must be awaited, not read at once.
    expect(await screen.findByRole('img', { name: 'slip.png' })).toBeTruthy();
  });

  it('opens the list, not the viewer, from a plain paperclip', async () => {
    serve([file('a1', 'slip.png')]);
    render(<BankTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Attachments, .*NO FILES/ }));
    expect(await screen.findByRole('dialog', { name: 'Attachments' })).toBeTruthy();
    await screen.findByRole('button', { name: 'View slip.png' });
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).toBeNull();
  });

  it('moves the row\'s count on a remove, without reloading the list', async () => {
    serve([file('a1', 'slip.png'), file('a2', 'two.png')]);
    render(<BankTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^2 attachments - view, .*WITH FILES/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Close preview' }));
    const listReads = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('/api/accounting/bank-transactions?')).length;
    const before = listReads();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove slip.png' }));
    await screen.findByRole('button', { name: /^1 attachment - view, .*WITH FILES/ });
    expect(listReads()).toBe(before);
  });
});

describe('the client queries page', () => {
  it('moves "View slips (N)" on a remove', async () => {
    serve([file('a1', 'slip.png'), file('a2', 'two.png')]);
    render(<QueriesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /View slips \(2\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove slip.png' }));
    await screen.findByRole('button', { name: /View slips \(1\)/ });
  });
});
