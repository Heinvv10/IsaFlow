/**
 * D2 round 6 (g5): FlowWalletWidget (never a made-up zero), MissingInvoiceModals, AttachToTransactionSheet,
 * AuthContext sign-in (a 503 is an outage, not a wrong password), TwoFactorSection rollback wording.
 * 4xx real envelope -> server message; empty-body 500 -> plain sentence; 200 -> completes. REAL assertOk / apiErrorMessage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast }));
vi.mock('@/components/billing/TopUpModal', () => ({ TopUpModal: () => null }));
vi.mock('@/components/billing/UpgradeNudgeBanner', () => ({ UpgradeNudgeBanner: () => null }));

import { FlowWalletWidget } from '@/components/billing/FlowWalletWidget';
import { MissingInvoiceModals, type ExpectedAlert } from '@/components/accounting/suppliers/MissingInvoiceModals';
import { AttachToTransactionSheet } from '@/components/capture/AttachToTransactionSheet';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); toast.success.mockReset(); toast.error.mockReset(); });
afterEach(() => { cleanup(); });

describe('FlowWalletWidget', () => {
  it('a failed load never shows a made-up zero balance', async () => {
    route(() => empty500());
    render(<FlowWalletWidget />);
    expect(await screen.findByText('Could not load the Flow balance - try again')).toBeTruthy();
    expect(screen.queryByText(/used this month/)).toBeNull();
    expect(noRawText()).toBe(true);
  });
  it('a refused load shows the same sentence, not a zero', async () => {
    route(() => bad());
    render(<FlowWalletWidget />);
    expect(await screen.findByText('Could not load the Flow balance - try again')).toBeTruthy();
  });
  it('a 200 shows the real balance', async () => {
    route(() => ok({ balance: 42, nudgeLevel: 'none', monthFlowsUsed: 7 }));
    render(<FlowWalletWidget />);
    expect(await screen.findByText('42')).toBeTruthy();
    expect(screen.getByText(/7 used this month/)).toBeTruthy();
  });
});

describe('MissingInvoiceModals', () => {
  const ALERT = { id: 'a-1', companyId: 'c', supplierId: 's', supplierName: 'D2 Supplier', supplierEmail: 'x@example.com', supplierWhatsappNumber: null,
    expectationId: null, expectedBy: '2026-01-01', expectedAmount: 10, daysOverdue: 3, status: 'pending', chasedAt: null, chaseMethod: null,
    chaseToAddress: null, resolvedInvoiceId: null, resolvedAt: null, dismissedReason: null } as ExpectedAlert;
  function open() {
    const cb = { onClose: vi.fn(), onSuccess: vi.fn(), onError: vi.fn() };
    render(<MissingInvoiceModals chaseAlert={ALERT} resolveAlert={null} dismissAlert={null} {...cb} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send email' }));
    return cb;
  }
  it('a refused chase reports the server message and stays open', async () => {
    route(() => bad());
    const cb = open();
    await waitFor(() => expect(cb.onError).toHaveBeenCalledWith(MSG));
    expect(cb.onClose).not.toHaveBeenCalled();
  });
  it('an empty-500 chase reports a plain sentence naming the action', async () => {
    route(() => empty500());
    const cb = open();
    await waitFor(() => expect(cb.onError).toHaveBeenCalledWith('Could not send the chase - try again'));
    expect(cb.onSuccess).not.toHaveBeenCalled();
  });
  it('a dropped connection reports the sentence (no unhandled rejection) and re-enables the button', async () => {
    vi.mocked(apiFetch).mockReset().mockRejectedValue(new TypeError('Failed to fetch'));
    const cb = open();
    await waitFor(() => expect(cb.onError).toHaveBeenCalledWith('Could not send the chase - try again'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Send email' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('a 200 chase reports success and closes', async () => {
    route(() => ok({}));
    const cb = open();
    await waitFor(() => expect(cb.onSuccess).toHaveBeenCalledWith('Chase email queued successfully'));
    expect(cb.onClose).toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });
});

describe('AttachToTransactionSheet', () => {
  const TX = { id: 'tx-1', transactionDate: '2026-01-05', description: 'D2 PAYMENT', amount: 10 };
  const list = () => ok({ transactions: [TX] });
  it('a failed list load shows a plain sentence and no rows', async () => {
    route(() => empty500());
    render(<AttachToTransactionSheet documentIds={['d1']} onDone={vi.fn()} />);
    expect(await screen.findByText('Could not load the transactions - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a refused attach toasts the server message and does not finish', async () => {
    const onDone = vi.fn();
    route((_u, m) => (m === 'POST' ? bad() : list()));
    render(<AttachToTransactionSheet documentIds={['d1']} onDone={onDone} />);
    fireEvent.click(await screen.findByText('D2 PAYMENT'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG));
    expect(onDone).not.toHaveBeenCalled();
  });
  it('a failure part-way through several documents says how many were attached', async () => {
    let posts = 0;
    route((_u, m) => { if (m !== 'POST') return list(); posts += 1; return posts === 1 ? ok({}) : empty500(); });
    render(<AttachToTransactionSheet documentIds={['d1', 'd2']} onDone={vi.fn()} />);
    fireEvent.click(await screen.findByText('D2 PAYMENT'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('1 of 2 documents attached. Could not attach the document - try again'));
  });
  it('a good attach finishes', async () => {
    const onDone = vi.fn();
    route((_u, m) => (m === 'POST' ? ok({}) : list()));
    render(<AttachToTransactionSheet documentIds={['d1']} onDone={onDone} />);
    fireEvent.click(await screen.findByText('D2 PAYMENT'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Attached to transaction');
  });
});

describe('AuthContext sign-in', () => {
  function Probe() {
    const { login, error } = useAuth();
    return <div><button onClick={() => { void login('a@b.co', 'pw').catch(() => undefined); }}>SIGN IN</button><span>ERR: {error ?? 'none'}</span></div>;
  }
  async function signIn(login: () => Response) {
    route((url) => (url.includes('/api/auth/login') ? login() : ok({ user: null })));
    render(<AuthProvider><Probe /></AuthProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'SIGN IN' }));
  }
  it('an empty-body 503 says sign-in is unavailable, never a wrong password or a JSON error', async () => {
    await signIn(() => new Response('', { status: 503 }));
    expect(await screen.findByText(/Sign-in is temporarily unavailable - please try again shortly/)).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('an empty-body 500 says could not sign in', async () => {
    await signIn(() => empty500());
    expect(await screen.findByText(/ERR: Could not sign in - try again/)).toBeTruthy();
  });
  it('a 401 keeps the server message', async () => {
    await signIn(() => bad(401));
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });
  it('a 503 that carries its own sentence keeps it', async () => {
    await signIn(() => new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'D2 auth is down for maintenance' } }), { status: 503 }));
    expect(await screen.findByText(/D2 auth is down for maintenance/)).toBeTruthy();
  });
});
