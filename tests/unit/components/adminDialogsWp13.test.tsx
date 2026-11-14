// Admin dialogs (WP13, admin audit 4.13): ConfirmModal, Login As, webhook delete, waitlist Promote and Add
// Subscription are real modal dialogs. role=dialog with aria-modal, focus moves inside on open, Escape closes it
// (not while a request is in flight), and their inputs are labelled. Before, none of these closed on Escape and focus
// stayed on the page behind. Not covered here (follow-up once their PRs merge): AnnouncementModal (#1362),
// CreateInvoiceModal (#1368), ConvertTrialModal (#1363).
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/', asPath: '/' }) }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { LoginAsModal } from '@/components/admin/users/LoginAsModal';
import { ConfirmDeleteModal } from '@/components/admin/webhooks/ConfirmDeleteModal';
import WaitlistPage from '../../../pages/admin/waitlist/index';
import SubscriptionsPage from '../../../pages/admin/billing/subscriptions';

useApiJsonOverMock();
afterEach(() => { cleanup(); });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

async function expectModal(name?: RegExp) {
  const dialog = await screen.findByRole('dialog', name ? { name } : undefined);
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  return dialog;
}
const pressEscape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

describe('admin dialogs', () => {
  it.each([
    ['ConfirmModal', (close: () => void) => <ConfirmModal open title="Delete Company" message="Sure?" confirmLabel="Delete" onConfirm={vi.fn()} onCancel={close} />],
    ['LoginAsModal', (close: () => void) => <LoginAsModal user={{ first_name: 'Ann', last_name: 'Lee', email: 'a@b.test' }} redirectUrl={null} loading={false} onConfirm={vi.fn()} onOpenTab={vi.fn()} onClose={close} />],
    ['ConfirmDeleteModal', (close: () => void) => <ConfirmDeleteModal url="https://hook.test" loading={false} onConfirm={vi.fn()} onCancel={close} />],
  ])('%s: modal, focus inside, Escape closes', async (_name, make) => {
    const close = vi.fn();
    render(make(close));
    await expectModal();
    pressEscape();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('Waitlist Promote: modal, labelled Plan, Escape closes', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok({ items: [{ id: 'w-1', name: 'Ann', email: 'ann@x.test',
      signup_type: 'direct', company_name: 'Ann Co', practice_name: null, phone: null, annual_turnover_cents: null,
      created_at: '2026-11-01T00:00:00Z', promoted_at: null, promoted_company_id: null }], total: 1, page: 1, limit: 25, total_pages: 1 }));
    render(<WaitlistPage />);
    fireEvent.click(await screen.findByRole('button', { name: /promote/i }));
    const dialog = await expectModal(/promote waitlist signup/i);
    expect(within(dialog).getByLabelText('Plan').tagName).toBe('SELECT');
    pressEscape();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Waitlist Promote: Escape does nothing while the promote request is in flight (UI review L4)', async () => {
    let release: () => void = () => undefined;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        await new Promise<void>((r) => { release = r; });
        return ok({ companyId: null, status: 'promoted' });
      }
      return ok({ items: [{ id: 'w-1', name: 'Ann', email: 'ann@x.test', signup_type: 'direct', company_name: 'Ann Co',
        practice_name: null, phone: null, annual_turnover_cents: null, created_at: '2026-11-01T00:00:00Z', promoted_at: null,
        promoted_company_id: null }], total: 1, page: 1, limit: 25, total_pages: 1 });
    });
    render(<WaitlistPage />);
    fireEvent.click(await screen.findByRole('button', { name: /promote/i }));
    const dialog = await expectModal(/promote waitlist signup/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /create company/i }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
    pressEscape();
    expect(screen.getByRole('dialog')).toBe(dialog);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Add Subscription: modal, labelled fields, Escape closes', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).startsWith('/api/admin/billing/plans')
      ? ok([]) : ok({ items: [], total: 0, page: 1, limit: 25 })));
    render(<SubscriptionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add subscription/i }));
    const dialog = await expectModal(/add subscription/i);
    expect(within(dialog).getByLabelText('Billing Cycle').tagName).toBe('SELECT');
    expect(within(dialog).getByLabelText('Discount %').tagName).toBe('INPUT');
    pressEscape();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
