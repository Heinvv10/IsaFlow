// D2 round 9: SUCCESS paths (and the failure shape beside them) of converted components, served with the real route envelope.
//   CaptureApiKeysSection, ChangeEmailSection, BulkActionBar, DrcFlagToggle, VatPeriodLocksPanel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: toast }));
vi.mock('@/utils/toast', () => ({ notify }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));

import { apiFetch } from '@/lib/apiFetch';
import { CaptureApiKeysSection } from '@/components/accounting/capture/CaptureApiKeysSection';
import { ChangeEmailSection } from '@/components/accounting/my-account/ChangeEmailSection';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';
import { DrcFlagToggle } from '@/components/accounting/suppliers/DrcFlagToggle';
import { VatPeriodLocksPanel } from '@/components/accounting/sars/VatPeriodLocksPanel';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); for (const f of [toast.error, toast.success, notify.error, notify.success]) f.mockReset(); });
afterEach(() => { cleanup(); });

const posts = (part: string) => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).includes(part) && (i as RequestInit | undefined)?.method);

describe('CaptureApiKeysSection (route: GET data = rows { id, label, key_prefix, is_active, last_used_at, created_at }; POST 201 data = { key, id, label, prefix })', () => {
  const rows = [
    { id: 'k1', label: 'D2 Phone App', key_prefix: 'cap_d2aa', is_active: true, last_used_at: null, created_at: '2026-09-01T00:00:00Z' },
    { id: 'k2', label: 'D2 Old Key', key_prefix: 'cap_d2bb', is_active: false, last_used_at: '2026-08-15T00:00:00Z', created_at: '2026-07-01T00:00:00Z' },
  ];
  it('lists label, prefix, last used and Active/Revoked per key', async () => {
    serve(on('GET', 'capture/api-keys', () => ok(rows)));
    render(<CaptureApiKeysSection showToast={vi.fn()} />);
    const active = (await screen.findByText('D2 Phone App')).closest('tr') as HTMLElement;
    expect(within(active).getByText('cap_d2aa…')).toBeDefined();
    expect(within(active).getByText('Never')).toBeDefined();
    expect(within(active).getByText('Active')).toBeDefined();
    const revoked = screen.getByText('D2 Old Key').closest('tr') as HTMLElement;
    expect(within(revoked).getByText('Revoked')).toBeDefined();
    expect(within(revoked).queryByText('Never')).toBeNull();   // last_used_at is rendered as a date
  });
  it('generating a key shows the one-time secret from the response', async () => {
    serve(on('POST', 'capture/api-keys', () => new Response(JSON.stringify({ success: true, data: { key: 'D2 one-time key text', id: 'k3', label: 'D2 New', prefix: 'cap_d2cc' } }), { status: 201 })),
      on('GET', 'capture/api-keys', () => ok(rows)));
    render(<CaptureApiKeysSection showToast={vi.fn()} />);
    await screen.findByText('D2 Phone App');
    fireEvent.change(screen.getByPlaceholderText(/Key label/), { target: { value: 'D2 New' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(await screen.findByText('D2 one-time key text')).toBeDefined();
    expect(JSON.parse((posts('capture/api-keys')[0]![1] as RequestInit).body as string)).toEqual({ label: 'D2 New' });
  });
  it('an empty 500 toasts a sentence and lists no keys; a reload that fails drops the old rows', async () => {
    const showToast = vi.fn();
    serve(on('GET', 'capture/api-keys', empty500));
    render(<CaptureApiKeysSection showToast={showToast} />);
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Could not load the API keys - try again', false));
    expect(screen.queryByText('D2 Phone App')).toBeNull(); expectNoJargon();
  });
});

describe('ChangeEmailSection (route: 200 { success, data: { email, message } })', () => {
  const fill = () => {
    render(<ChangeEmailSection currentEmail="old-d2@x.test" />);
    fireEvent.change(screen.getByPlaceholderText('new@example.com'), { target: { value: ' New-D2@X.test ' } });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'pw-d2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
  };
  it('posts the trimmed lower-cased address and password, then says the email changed', async () => {
    serve(on('POST', 'auth/change-email', () => ok({ email: 'new-d2@x.test', message: 'Email changed.' })));
    fill();
    expect(await screen.findByText('new-d2@x.test')).toBeDefined();
    expect(JSON.parse((posts('change-email')[0]![1] as RequestInit).body as string)).toEqual({ newEmail: 'new-d2@x.test', currentPassword: 'pw-d2' });
    expect(toast.success).toHaveBeenCalledWith('Email changed to new-d2@x.test');
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('a 400 toasts the server message and shows no success banner; an empty 500 a sentence', async () => {
    serve(on('POST', 'auth/change-email', () => refuse()));
    fill();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MSG));
    expect(screen.queryByText(/Use it next time/)).toBeNull();
    cleanup(); toast.error.mockReset();
    serve(on('POST', 'auth/change-email', empty500));
    fill();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not change your email - try again'));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe('BulkActionBar (route: data = { total, succeeded, failed, results: [{ invoiceId, ok, error? }] })', () => {
  function Page({ onComplete }: { onComplete: () => void }) {
    const [error, setError] = useState('');
    const [busy, setBusy] = useState<'approve' | 'post_gl' | 'cancel' | null>(null);
    return (<><p role="alert">{error}</p>
      <BulkActionBar selected={new Set(['i1', 'i2', 'i3'])} busy={busy} onBusyChange={setBusy} onError={setError} onComplete={onComplete} onClear={() => {}} /></>);
  }
  beforeEach(() => { vi.stubGlobal('confirm', () => true); });
  it('all succeeded: posts action + ids, reloads, leaves no error', async () => {
    const onComplete = vi.fn();
    serve(on('POST', 'supplier-invoices-bulk-action', () => ok({ total: 3, succeeded: 3, failed: 0, results: [{ invoiceId: 'i1', ok: true }, { invoiceId: 'i2', ok: true }, { invoiceId: 'i3', ok: true }] })));
    render(<Page onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(JSON.parse((posts('bulk-action')[0]![1] as RequestInit).body as string)).toEqual({ action: 'approve', invoiceIds: ['i1', 'i2', 'i3'] });
    expect(screen.getByRole('alert').textContent).toBe('');
  });
  it('partly failed: the count and the grouped reasons from results[] are shown', async () => {
    serve(on('POST', 'supplier-invoices-bulk-action', () => ok({ total: 3, succeeded: 1, failed: 2,
      results: [{ invoiceId: 'i1', ok: true }, { invoiceId: 'i2', ok: false, error: 'D2 already posted' }, { invoiceId: 'i3', ok: false, error: 'D2 already posted' }] })));
    render(<Page onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Post to GL' }));
    expect((await screen.findByRole('alert')).textContent).toBe('2 of 3 GL postings failed: D2 already posted');
  });
});

describe('DrcFlagToggle (route: PATCH data = { id, subject_to_drc_vat })', () => {
  it('flipping the switch PATCHes the supplier and keeps it on', async () => {
    serve(on('PATCH', 'suppliers-list', () => ok({ id: 's1', subject_to_drc_vat: true })));
    render(<DrcFlagToggle supplierId="s1" initial={false} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Supplier marked as subject to DRC VAT'));
    expect(JSON.parse((posts('suppliers-list')[0]![1] as RequestInit).body as string)).toEqual({ id: 's1', subject_to_drc_vat: true });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });
  it('a refused save puts the switch back and says why; an empty 500 says a sentence', async () => {
    serve(on('PATCH', 'suppliers-list', () => refuse()));
    render(<DrcFlagToggle supplierId="s1" initial={false} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    cleanup(); notify.error.mockReset();
    serve(on('PATCH', 'suppliers-list', empty500));
    render(<DrcFlagToggle supplierId="s1" initial={true} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not save the DRC VAT flag - try again'));
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });
});

describe('VatPeriodLocksPanel (route: GET data = { locks: VatPeriodLock[] })', () => {
  const lock = { id: 'l1', periodStart: '2026-07-01', periodEnd: '2026-08-31', outputTax: 15000, inputTax: 4000, netVat: 11000, postedThrough: '2026-09-01T00:00:00Z',
    lockedBy: 'u1', lockedByName: 'D2 Locker', actorType: 'human', actorTokenJti: null, lockedAt: '2026-09-02T00:00:00Z', notes: 'D2 filed note', active: true,
    unlockedAt: null, unlockedBy: null, unlockedByName: null, unlockReason: null };
  it('success: shows who locked, the note, the netVat figure and Active', async () => {
    serve(on('GET', 'vat-period-locks', () => ok({ locks: [lock] })));
    render(<VatPeriodLocksPanel />);
    const row = (await screen.findByText('Active')).closest('tr') as HTMLElement;
    expect(row.textContent).toContain('D2 Locker');
    expect(row.textContent).toContain('D2 filed note');
    expect(row.textContent).toMatch(/11[\s  ]000/);
  });
  it('empty 500: a sentence and no rows', async () => {
    serve(on('GET', 'vat-period-locks', empty500));
    render(<VatPeriodLocksPanel />);
    expect(await screen.findByText('Could not load the VAT period locks - try again')).toBeDefined();
    expect(screen.queryByText('Active')).toBeNull(); expectNoJargon();
  });
  it('a network rejection: a sentence and no rows', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    render(<VatPeriodLocksPanel />);
    expect(await screen.findByText('Could not load the VAT period locks - try again')).toBeDefined();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });
  it('no stale rows: the unlock succeeds, the reload is refused, and the old lock is not left on screen', async () => {
    let unlocked = false;
    serve((u, m) => (m === 'POST' && u.includes('vat-period-locks') ? ((unlocked = true), ok({ lock: { ...lock, active: false } })) : undefined),
      (u, m) => (m === 'GET' && u.includes('vat-period-locks') ? (unlocked ? empty500() : ok({ locks: [lock] })) : undefined));
    render(<VatPeriodLocksPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /^Unlock$/ }));
    fireEvent.change(screen.getByPlaceholderText(/Why is this period being unlocked/i), { target: { value: 'D2 correcting an error' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm unlock' }));
    expect(await screen.findByText('Could not load the VAT period locks - try again')).toBeDefined();
    expect(screen.queryByText('D2 Locker')).toBeNull();
  });
});
