/**
 * Master plan U, fix-round review: Ctrl+Z behind an open modal posted a contra nobody asked for. Every modal of the bank
 * page is a named modal dialog, so the hotkey stands down while one is open, wherever focus is: seven of them never took
 * focus, so the key arrived on <body>. Each real modal, the real notify and the real Toaster.
 */
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import toast, { Toaster } from 'react-hot-toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/assets/fleetRecordsApi', () => ({ loadFuelRecords: async () => [], loadServiceRecords: async () => [] }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { SplitTransactionModal } from '@/components/accounting/SplitTransactionModal';
import { FindMatchModal } from '@/components/accounting/FindMatchModal';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
import { ExcludeReasonModal } from '@/components/accounting/ExcludeReasonModal';
import { CreateRuleModal } from '@/components/accounting/CreateRuleModal';
import { CreateEntityModal } from '@/components/accounting/CreateEntityModal';
import { BankTxQueryModal } from '@/components/accounting/BankTxQueryModal';
import { BankTxLinkModal } from '@/components/accounting/bank-transactions/BankTxLinkModal';

useApiJsonOverMock();

const TX = { id: 'bt-1', description: 'WOOLWORTHS', amount: -115, transactionDate: '2026-06-01', status: 'imported' };
const none = () => undefined;

const MODALS: [string, string, ReactElement][] = [
  ['Split', 'Split transaction', <SplitTransactionModal key="s" transaction={TX as never} glAccounts={[]} suppliers={[]} customers={[]} onClose={none} onSplit={none} />],
  ['Find Match', 'Find a match', <FindMatchModal key="f" transaction={TX} onClose={none} onMatch={none} />],
  ['Attachments', 'Attachments', <BankTxAttachmentsModal key="a" bankTransactionId={TX.id} onClose={none} />],
  ['Exclude', 'Exclude transaction', <ExcludeReasonModal key="e" transaction={TX} onClose={none} onExclude={none} />],
  ['Create Rule', 'Create a bank rule', <CreateRuleModal key="r" transaction={TX as never} bankAccountId="bank-1" glAccounts={[]} onClose={none} onCreated={none} />],
  ['Create Entity', 'Create a new record', <CreateEntityModal key="c" type="supplier" transactionDescription="WOOLWORTHS" existingAccounts={[]} onClose={none} onCreated={none} />],
  ['Query', 'Ask the client', <BankTxQueryModal key="q" tx={TX as never} onClose={none} />],
  ['Link', 'Link to asset / fuel / service', <BankTxLinkModal key="l" tx={TX as never} onClose={none} onDone={none} />],
];

beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 }));
});
afterEach(() => {
  act(() => { toast.remove(); });
  cleanup();
});

describe.each(MODALS)('the %s modal', (_name, label, modal) => {
  it('is a named modal dialog', async () => {
    render(modal);
    const dialog = await screen.findByRole('dialog', { name: label });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('holds Ctrl+Z with focus on the page behind it, and lets it through once it has gone', async () => {
    const onUndo = vi.fn();
    const { unmount } = render(<><Toaster />{modal}</>);
    act(() => { notify.undoable('Transaction allocated', { onUndo }); });
    await screen.findByRole('dialog', { name: label });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(onUndo).not.toHaveBeenCalled();

    unmount();
    render(<Toaster />);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
