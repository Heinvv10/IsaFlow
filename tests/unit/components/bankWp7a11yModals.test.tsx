/**
 * WP7 accessibility: the seven modals the bank-transactions page opens share ONE shell (BankTxModalShell: kit
 * useFocusTrap, named modal dialog, Escape, focus return, portal to the body, busy guard), and the real modals use it.
 */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }), { status: 200 })) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }), useCompanyRoleOrNull: () => 'owner' }));

import { BankTxModalShell, FIELD_WAIT_MS, useTrackLastClick } from '@/components/accounting/bank-transactions/BankTxModalShell';
import { ExcludeReasonModal } from '@/components/accounting/ExcludeReasonModal';
import { CreateRuleModal } from '@/components/accounting/CreateRuleModal';
import { CreateEntityModal } from '@/components/accounting/CreateEntityModal';
import { BankTxQueryModal } from '@/components/accounting/BankTxQueryModal';
import { BankTxLinkModal } from '@/components/accounting/bank-transactions/BankTxLinkModal';
import { SplitTransactionModal } from '@/components/accounting/SplitTransactionModal';
import { FindMatchModal } from '@/components/accounting/FindMatchModal';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
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

const noop = vi.fn();
const cases: Array<[string, string, () => JSX.Element]> = [
    ['Exclude', 'Exclude transaction', () => <ExcludeReasonModal transaction={TX} onExclude={noop} onClose={noop} /> as never],
    ['Create rule', 'Create a bank rule', () => <CreateRuleModal transaction={TX} bankAccountId="b1" glAccounts={[]} onClose={noop} onCreated={noop} /> as never],
    ['Create entity', 'Create a new record', () => <CreateEntityModal type="supplier" onClose={noop} onCreated={noop} /> as never],
    ['Query', 'Ask the client', () => <BankTxQueryModal tx={TX} onClose={noop} /> as never],
    ['Link', 'Link to asset / fuel / service', () => <BankTxLinkModal tx={TX} onClose={noop} onDone={noop} /> as never],
    ['Split', 'Split transaction', () => <SplitTransactionModal transaction={TX} glAccounts={[]} onClose={noop} onSplit={noop} /> as never],
    ['Attachments', 'Attachments', () => <BankTxAttachmentsModal bankTransactionId="tx-1" onClose={noop} /> as never],
    ['Find match', 'Find a match', () => <FindMatchModal transaction={TX} onClose={noop} onMatch={noop} /> as never],
];

describe('the eight modals use the shell: a named dialog in the body that closes on Escape', () => {
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


describe('every button in every shell modal has an accessible name (axe button-name)', () => {
  const name = (b: HTMLElement) => (b.getAttribute('aria-label') ?? b.getAttribute('aria-labelledby') ?? b.textContent ?? b.getAttribute('title') ?? '').trim();
  it.each(cases)('%s', (_n, dialogName, ui) => {
    render(ui());
    const buttons = Array.from(screen.getByRole('dialog', { name: dialogName }).querySelectorAll<HTMLElement>('button, [role="button"]'));
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.filter(b => name(b) === '').map(b => b.outerHTML.slice(0, 120))).toEqual([]);
  });
});

describe('initial focus: the first field, not the close button', () => {
  it('on the shell: a [data-autofocus] element wins, else the first text field, else the first control', () => {
    const { unmount } = render(<BankTxModalShell label="A" onClose={vi.fn()}><button aria-label="Close">x</button><input aria-label="one" /><input aria-label="two" data-autofocus /></BankTxModalShell>);
    expect(document.activeElement).toBe(screen.getByLabelText('two'));
    unmount();
    const r = render(<BankTxModalShell label="A" onClose={vi.fn()}><button aria-label="Close">x</button><input type="checkbox" aria-label="box" /><input aria-label="one" /></BankTxModalShell>);
    expect(document.activeElement).toBe(screen.getByLabelText('one')); // not the close button, not the checkbox
    r.unmount();
    render(<BankTxModalShell label="A" onClose={vi.fn()}><button aria-label="Close">x</button><button>other</button></BankTxModalShell>);
    expect(document.activeElement).toBe(screen.getByLabelText('Close')); // last resort
  });
  it('Enter right after opening does not close FindMatch / Split (focus is on a field)', async () => {
    const onClose = vi.fn();
    render(<FindMatchModal transaction={{ id: 'tx-1', amount: -115, description: 'W', transactionDate: '2026-06-01' } as never} onClose={onClose} onMatch={vi.fn()} />);
    expect(document.activeElement?.tagName).toBe('INPUT');
    expect(document.activeElement?.getAttribute('aria-label') ?? '').not.toMatch(/close/i);
  });
});

describe('focus goes back where the user was', () => {
  function Page({ returnFocus }: { returnFocus?: () => HTMLElement | null }) {
    const [open, setOpen] = useState(false);
    useTrackLastClick();
    return (
      <div>
        <div data-testid="bank-tx-table"><button data-testid="row-btn" onClick={() => setOpen(true)}>row action</button></div>
        {open && <BankTxModalShell label="T" onClose={() => setOpen(false)} returnFocus={returnFocus}><input aria-label="f" /></BankTxModalShell>}
      </div>
    );
  }
  it('Safari/macOS Firefox: a click does not focus the button (activeElement is the body): focus still returns to it', () => {
    render(<Page />);
    const btn = screen.getByTestId('row-btn');
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(btn); // no focus() - as those browsers
    expect(document.activeElement).not.toBe(btn);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(btn);
  });
  it('an explicit returnFocus target is used when what opened it is gone', () => {
    const { rerender } = render(<Page returnFocus={() => document.getElementById('fallback')} />);
    document.body.insertAdjacentHTML('beforeend', '<button id="fallback">fb</button>');
    fireEvent.click(screen.getByTestId('row-btn'));
    screen.getByTestId('row-btn').remove(); // the row re-rendered away
    rerender(<Page returnFocus={() => document.getElementById('fallback')} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement?.id).toBe('fallback');
    document.getElementById('fallback')?.remove();
  });
  it('with nothing else, focus lands on the transaction grid', () => {
    render(<Page />);
    fireEvent.click(screen.getByTestId('row-btn'));
    screen.getByTestId('row-btn').remove();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByTestId('bank-tx-table'));
  });
});


describe('the last-click tracker lives only while its page does', () => {
  it('one document listener for any number of callers, removed with the last', () => {
    const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener');
    const clicks = (spy: typeof add) => spy.mock.calls.filter(c => c[0] === 'click').length;
    const a = renderHook(() => useTrackLastClick()), b = renderHook(() => useTrackLastClick());
    expect(clicks(add)).toBe(1);
    a.unmount(); expect(clicks(remove)).toBe(0);
    b.unmount(); expect(clicks(remove)).toBe(1);
    add.mockRestore(); remove.mockRestore();
  });
  it('without a tracker (the page is gone) the shell does not remember an old click', () => {
    function Bare() {
      const [open, setOpen] = useState(false);
      return <div><button data-testid="b" onClick={() => setOpen(true)}>b</button>{open && <BankTxModalShell label="T" onClose={() => setOpen(false)}><input aria-label="f" /></BankTxModalShell>}</div>;
    }
    render(<Bare />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByTestId('b'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(screen.getByTestId('b'));
  });
});

describe('fields that appear after an async load', () => {
  it('focus moves to the first field when it appears, if focus is still on the dialog chrome', async () => {
    function Late() {
      const [ready, setReady] = useState(false);
      return <BankTxModalShell label="L" onClose={vi.fn()}><button aria-label="Close">x</button>{ready && <input aria-label="late field" />}<button onClick={() => setReady(true)}>load</button></BankTxModalShell>;
    }
    render(<Late />);
    expect(document.activeElement).toBe(screen.getByLabelText('Close'));
    fireEvent.click(screen.getByText('load'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('late field')));
  });
  it('...but never steals focus the user has moved elsewhere', async () => {
    function Late() {
      const [ready, setReady] = useState(false);
      return <BankTxModalShell label="L" onClose={vi.fn()}><button aria-label="Close">x</button><button onClick={() => setReady(true)}>load</button>{ready && <input aria-label="late field" />}</BankTxModalShell>;
    }
    render(<Late />);
    const load = screen.getByText('load');
    load.focus(); // the user moved on
    fireEvent.click(load);
    await Promise.resolve();
    expect(document.activeElement).toBe(load);
  });
  it('stops watching after FIELD_WAIT_MS: a field that appears later is not focused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      function Late() {
        const [ready, setReady] = useState(false);
        return <BankTxModalShell label="L" onClose={vi.fn()}><button aria-label="Close">x</button><button onClick={() => setReady(true)}>load</button>{ready && <input aria-label="late field" />}</BankTxModalShell>;
      }
      render(<Late />);
      const close = screen.getByLabelText('Close');
      act(() => { vi.advanceTimersByTime(FIELD_WAIT_MS + 100); });
      fireEvent.click(screen.getByText('load'));
      expect(screen.getByLabelText('late field')).toBeTruthy();
      await Promise.resolve(); await Promise.resolve(); // the observer's callback is a microtask
      expect(document.activeElement).toBe(close);
    } finally { vi.useRealTimers(); }
  });
  it('Link opens on its asset search field, not the close button', () => {
    render(<BankTxLinkModal tx={TX} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(document.activeElement?.id).toBe('link-asset-search');
  });
});
