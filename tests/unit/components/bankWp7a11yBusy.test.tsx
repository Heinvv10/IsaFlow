/**
 * WP7 a11y: each REAL modal holds its dialog while its request is in flight. The request is held pending, then Escape and
 * a click on the Close button (and Cancel) do nothing; when it answers the modal closes normally. Wiring lost from any one
 * modal (`busy={locked}`, or its close buttons' `disabled`) turns its test red. A request that never answers releases the
 * dialog after BUSY_RELEASE_MS, with a warning.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }), useCompanyRoleOrNull: () => 'owner' }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/components/accounting/CreateRuleModal', async (orig) => ({ ...(await orig<typeof import('@/components/accounting/CreateRuleModal')>()) }));

import { apiFetch } from '@/lib/apiFetch';
import { BUSY_RELEASE_MS, UPLOAD_RELEASE_MS } from '@/components/accounting/bank-transactions/BankTxModalShell';
import { CreateRuleModal } from '@/components/accounting/CreateRuleModal';
import { CreateEntityModal } from '@/components/accounting/CreateEntityModal';
import { BankTxQueryModal } from '@/components/accounting/BankTxQueryModal';
import { BankTxLinkModal } from '@/components/accounting/bank-transactions/BankTxLinkModal';
import { SplitTransactionModal } from '@/components/accounting/SplitTransactionModal';
import { FindMatchModal } from '@/components/accounting/FindMatchModal';
import { BankTxAttachmentsModal } from '@/components/accounting/BankTxAttachmentsModal';
import type { BankTx } from '@/components/accounting/BankTxTable';

const TX = { id: 'tx-1', transactionDate: '2026-06-01', description: 'WOOLWORTHS', amount: -115, status: 'imported' } as BankTx;
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const GL = [{ id: 'gl1', code: '6000', name: 'Telephone' }];
let answer: (r: Response) => void;
/** Every request answers at once EXCEPT the write named by `isWrite`, which stays pending until `answer` is called. */
function hold(isWrite: (url: string, init?: RequestInit) => boolean, reads: (url: string) => unknown = () => []) {
  vi.mocked(apiFetch).mockImplementation(async (u, init) => {
    const url = String(u);
    if (isWrite(url, init as RequestInit | undefined)) return new Promise<Response>(r => { answer = r; });
    return ok(reads(url));
  });
}
/** apiJson (Create entity) calls the module's own apiFetch, which the mock above does not reach: hold the POST at fetch. */
function holdFetch() {
  vi.stubGlobal('fetch', (_u: unknown, init?: RequestInit) => (init?.method === 'POST' ? new Promise<Response>(r => { answer = r; }) : Promise.resolve(ok([]))));
}
const onClose = vi.fn();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); onClose.mockReset(); Object.values(toast).forEach(f => f.mockReset()); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const dialog = () => screen.getByRole('dialog');
async function expectHeld() {
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(dialog()); // the backdrop
  for (const b of within(dialog()).queryAllByRole('button', { name: /^(Cancel|Close.*)$/ })) {
    expect((b as HTMLButtonElement).disabled, `${b.textContent || b.getAttribute('aria-label')} is disabled while busy`).toBe(true);
    fireEvent.click(b);
  }
  expect(onClose).not.toHaveBeenCalled();
  expect(dialog().getAttribute('aria-busy')).toBe('true');
}
async function expectFreeAfter() {
  await act(async () => { answer(ok({ id: 'new', saved: true })); await new Promise(r => setTimeout(r, 0)); });
  await waitFor(() => expect(dialog().getAttribute('aria-busy')).toBeNull());
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
}

describe('a request in flight holds the dialog, in every modal', () => {
  it('Create entity', async () => {
    holdFetch();
    render(<CreateEntityModal type="customer" onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await waitFor(() => expect(dialog().getAttribute('aria-busy')).toBe('true'));
    await expectHeld(); await expectFreeAfter();
  });

  it('Query (ask the client)', async () => {
    hold((u, i) => i?.method === 'POST', (u) => (u.includes('settings') ? { clientQueryWhatsapp: '+27821234567', companyName: 'Acme' } : []));
    render(<BankTxQueryModal tx={TX} onClose={onClose} />);
    await waitFor(() => expect((screen.getByLabelText(/^WhatsApp number/) as HTMLInputElement).value).toBe('+27821234567'));
    fireEvent.click(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(dialog().getAttribute('aria-busy')).toBe('true'));
    await expectHeld(); await expectFreeAfter();
  });

  it('Link to asset', async () => {
    hold((u, i) => i?.method === 'POST', (u) => (u.includes('/assets') ? [{ id: 'as1', name: 'Truck', asset_number: 'A1' }] : []));
    render(<BankTxLinkModal tx={{ ...TX } as never} onClose={onClose} onDone={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Truck/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Link$/ }));
    await waitFor(() => expect(dialog().getAttribute('aria-busy')).toBe('true'));
    await expectHeld(); await expectFreeAfter();
  });

  it('Find a match', async () => {
    hold((u, i) => u.includes('bank-match-confirm'), (u) => ({ candidates: [{ type: 'supplier_invoice', id: 'c1', label: 'INV-1', amount: 115, date: '2026-06-01', reference: 'x', matchReason: 'amount' }] }));
    render(<FindMatchModal transaction={{ id: 'tx-1', amount: -115, description: 'W', transactionDate: '2026-06-01' } as never} onClose={onClose} onMatch={vi.fn()} />);
    fireEvent.click(await screen.findByText('INV-1'));
    fireEvent.click(screen.getByRole('button', { name: /Confirm|Match/ }));
    await waitFor(() => expect(dialog().getAttribute('aria-busy')).toBe('true'));
    await expectHeld(); await expectFreeAfter();
  });

  it('Create rule', async () => {
    hold((u, i) => i?.method === 'POST');
    render(<CreateRuleModal transaction={TX} bankAccountId="b1" glAccounts={GL} selection={{ type: 'account', entityId: 'gl1', label: 'Telephone', vatCode: 'none' }} onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Create Rule/ }));
    await waitFor(() => expect(dialog().getAttribute('aria-busy')).toBe('true'));
    await expectHeld(); await expectFreeAfter();
  });

  it('Split', async () => {
    hold((u, i) => i?.method === 'POST');
    render(<SplitTransactionModal transaction={TX} glAccounts={GL} onClose={onClose} onSplit={vi.fn()} />);
    fireEvent.click(screen.getByText(/Select|Choose/i, { selector: 'button, button *' }));
    fireEvent.click(await screen.findByText(/Telephone/));
    fireEvent.click(screen.getByRole('button', { name: /Split & Allocate/ }));
    await waitFor(() => expect(dialog().getAttribute('aria-busy')).toBe('true'));
    await expectHeld(); await expectFreeAfter();
  });
});

const png = () => new File([new Uint8Array([137, 80, 78, 71])], 'slip.png', { type: 'image/png' });
async function startUpload(onCountChange = vi.fn()) {
  hold((u, i) => i?.method === 'POST', () => []);
  const { container } = render(<BankTxAttachmentsModal bankTransactionId="tx-1" onCountChange={onCountChange} onClose={onClose} />);
  // vi.waitFor, not RTL's: it keeps working under fake timers
  await vi.waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  fireEvent.change(container.ownerDocument.querySelector('input[type="file"]')!, { target: { files: [png()] } });
  await vi.waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true), { timeout: 3000 });
  expect(dialog().getAttribute('aria-busy')).toBe('true');
  return onCountChange;
}

describe('Attachments: an upload in flight holds the dialog', () => {
  it('Escape, the backdrop and the close button wait; when it answers the dialog is free', async () => {
    await startUpload();
    await expectHeld(); await expectFreeAfter();
  });
  it('an upload is NOT released at the ordinary 30 s limit, only at the longer upload limit, with a warning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startUpload();
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_RELEASE_MS + 1000); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(UPLOAD_RELEASE_MS - BUSY_RELEASE_MS); });
    expect(toast.warning).toHaveBeenCalledWith('This is taking too long', expect.any(String));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('the result is still reported after the dialog was release-closed (the row count updates)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onCount = await startUpload();
    await act(async () => { await vi.advanceTimersByTimeAsync(UPLOAD_RELEASE_MS + 1000); });
    const { unmount } = { unmount: () => cleanup() };
    unmount(); // the parent closed it
    onCount.mockClear();
    await act(async () => { answer(ok({ id: 'a1' })); await vi.advanceTimersByTimeAsync(10); });
    await vi.waitFor(() => expect(onCount).toHaveBeenCalled());
  });
});

describe('a request that never answers releases the dialog', () => {
  it('after BUSY_RELEASE_MS: a warning, then Escape closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    holdFetch();
    render(<CreateEntityModal type="customer" onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.change(screen.getAllByRole('textbox')[0]!, { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_RELEASE_MS - 100); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(toast.warning).toHaveBeenCalledWith('This is taking too long', expect.any(String));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
