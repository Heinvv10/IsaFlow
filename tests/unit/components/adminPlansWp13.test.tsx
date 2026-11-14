// Admin Plans (WP13, admin audit 2026-11-14):
//  - 4.17 on edit, Code is read-only (the API ignores it); a blank price is refused in the form, not a 400;
//  - 4.17 a price change reprices every subscriber at once: the form says so and Save asks for a confirm first.
//    Pricing behaviour itself is unchanged; a save without a price change goes straight through;
//  - 4.13 the form is a real dialog: labelled inputs, Escape closes.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import PlansPage from '../../../pages/admin/billing/plans';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const PLAN = { id: 'p-1', code: 'starter', name: 'Starter', description: 'Small', monthly_price_cents: 29900, annual_price_cents: 299000,
  currency: 'ZAR', features: {}, limits: {}, is_active: true, display_order: 1, created_at: '2026-01-01T00:00:00Z' };

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => (init?.method ? ok(PLAN) : ok([PLAN])));
});
afterEach(() => { cleanup(); });
const patches = () => vi.mocked(apiFetch).mock.calls.filter(([, i]) => i?.method === 'PATCH');

async function openEdit() {
  render(<PlansPage />);
  fireEvent.click(await screen.findByTitle('Edit'));
  return screen.findByRole('dialog');
}

describe('plan edit', () => {
  it('shows Code read-only and warns that a price change reprices subscribers', async () => {
    const dialog = await openEdit();
    expect((within(dialog).getByLabelText(/^code/i) as HTMLInputElement).readOnly).toBe(true);
    expect(dialog.textContent).toMatch(/every subscriber on this plan/i);
  });

  it('a price change saves only after the reprice confirm', async () => {
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText('Monthly Price (R)'), { target: { value: '349' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    const confirm = await screen.findByRole('dialog', { name: /reprice every subscriber/i });
    expect(patches()).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: /save new price/i }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.parse(String(patches()[0]![1]?.body))).toMatchObject({ monthly_price_cents: 34900, annual_price_cents: 299000 });
  });

  it('a save without a price change needs no confirm', async () => {
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Starter Plus' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: /reprice/i })).toBeNull();
  });

  it('a blank price is refused in the form', async () => {
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText('Annual Price (R)'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    expect(await within(dialog).findByText(/prices must be amounts in rands/i)).toBeTruthy();
    expect(patches()).toHaveLength(0);
  });

  it('Escape closes the form', async () => {
    await openEdit();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
