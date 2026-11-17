/**
 * WP7 accessibility: the seven modals the bank-transactions page opens share ONE shell (BankTxModalShell: kit
 * useFocusTrap, named modal dialog, Escape, focus return, portal to the body, busy guard), and the real modals use it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }), useCompanyRoleOrNull: () => 'owner' }));

import { BankTxModalShell } from '@/components/accounting/bank-transactions/BankTxModalShell';
import { ExcludeReasonModal } from '@/components/accounting/ExcludeReasonModal';
import { CreateRuleModal } from '@/components/accounting/CreateRuleModal';
import { CreateEntityModal } from '@/components/accounting/CreateEntityModal';
import { BankTxQueryModal } from '@/components/accounting/BankTxQueryModal';
import { BankTxLinkModal } from '@/components/accounting/bank-transactions/BankTxLinkModal';
import { SplitTransactionModal } from '@/components/accounting/SplitTransactionModal';
import { FindMatchModal } from '@/components/accounting/FindMatchModal';
import type { BankTx } from '@/components/accounting/BankTxTable';

afterEach(cleanup);
const TX = { id: 'tx-1', transactionDate: '2026-06-01', description: 'WOOLWORTHS', amount: -115, status: 'imported' } as BankTx;

function Harness({ busy = false, backdrop = false }: { busy?: boolean; backdrop?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      {open && <BankTxModalShell label="Test dialog" onClose={() => setOpen(false)} busy={busy} closeOnBackdrop={backdrop}>
        <div><button>first</button><input aria-label="mid" /><button>last</button></div>
      </BankTxModalShell>}
    </>
  );
}
const openIt = () => { const b = screen.getByText('opener'); b.focus(); fireEvent.click(b); return b; };

describe('BankTxModalShell', () => {
  it('is a named modal dialog, rendered into the body, with focus moved inside', () => {
    render(<Harness />); openIt();
    const d = screen.getByRole('dialog', { name: 'Test dialog' });
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.parentElement).toBe(document.body);
    expect(d.contains(document.activeElement)).toBe(true);
  });
  it('Escape closes it and focus returns to what opened it', () => {
    render(<Harness />); const opener = openIt();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('Tab wraps inside (last -> first, Shift+Tab first -> last)', () => {
    render(<Harness />); openIt();
    const first = screen.getByText('first'), last = screen.getByText('last');
    last.focus(); fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus(); fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
  it('while busy, Escape and a backdrop click do nothing', () => {
    render(<Harness busy backdrop />); openIt();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('a backdrop click closes only when asked to, and only on the backdrop itself', () => {
    const { unmount } = render(<Harness />); openIt();
    fireEvent.click(screen.getByRole('dialog')); expect(screen.getByRole('dialog')).toBeTruthy();
    unmount();
    render(<Harness backdrop />); openIt();
    fireEvent.click(screen.getByText('first')); expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('dialog')); expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the seven modals use the shell: a named dialog in the body that closes on Escape', () => {
  const noop = vi.fn();
  const cases: Array<[string, string, () => JSX.Element]> = [
    ['Exclude', 'Exclude transaction', () => <ExcludeReasonModal transaction={TX} onExclude={noop} onClose={noop} /> as never],
    ['Create rule', 'Create a bank rule', () => <CreateRuleModal transaction={TX} bankAccountId="b1" glAccounts={[]} onClose={noop} onCreated={noop} /> as never],
    ['Create entity', 'Create a new record', () => <CreateEntityModal type="supplier" onClose={noop} onCreated={noop} /> as never],
    ['Query', 'Ask the client', () => <BankTxQueryModal tx={TX} onClose={noop} /> as never],
    ['Link', 'Link to asset / fuel / service', () => <BankTxLinkModal tx={TX} onClose={noop} onDone={noop} /> as never],
    ['Split', 'Split transaction', () => <SplitTransactionModal transaction={TX} glAccounts={[]} onClose={noop} onSplit={noop} /> as never],
    ['Find match', 'Find a match', () => <FindMatchModal transaction={TX} onClose={noop} onMatch={noop} /> as never],
  ];
  it.each(cases)('%s', (_n, name, ui) => {
    noop.mockClear();
    render(ui());
    const d = screen.getByRole('dialog', { name });
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(d.getAttribute('data-testid')).toBe('bank-tx-modal-shell');
    expect(d.parentElement).toBe(document.body);
    expect(d.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(noop).toHaveBeenCalledTimes(1);
  });
});
