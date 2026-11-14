// Admin audit 1.6 / 1.13 on the Trials page: "Convert to Paid" is offered for a
// running AND an expired trial (it used to key on companies.status, which
// provisioning never sets, so it showed on neither), never for a company that
// already pays; the Expired tab lists the expired trials; the convert dialog
// offers neither the internal trial/payg plans nor a preselected plan.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import TrialsPage from '../../../pages/admin/trials';
import { ConvertTrialModal } from '../../../src/components/admin/ConvertTrialModal';

useApiJsonOverMock();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const row = (id: string, name: string, trial_state: string, days_left: number) => ({
  id, name, plan_name: null, trial_ends_at: '2026-11-20T00:00:00Z', trial_started_at: '2026-10-20T00:00:00Z',
  user_count: 1, status: 'active', trial_state, days_left,
});
const TRIALS = [row('a', 'Running Co', 'active', 6), row('e', 'Expired Co', 'expired', -9), row('c', 'Paying Co', 'converted', -40)];
const STATS = { total_trials: 3, active_trials: 1, expiring_this_week: 1, expired_unpaid: 1, converted_this_month: 1, conversion_rate_percent: 33.33 };
const PLANS = [
  { id: 'p0', name: 'Free Trial', code: 'trial', monthly_price_cents: 0, currency: 'ZAR' },
  { id: 'p1', name: 'Pay as you go', code: 'payg', monthly_price_cents: 0, currency: 'ZAR' },
  { id: 'p2', name: 'Starter', code: 'starter', monthly_price_cents: 29900, currency: 'ZAR' },
  { id: 'p3', name: 'Professional', code: 'professional', monthly_price_cents: 59900, currency: 'ZAR' },
];

function serve() {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.startsWith('/api/admin/trials/stats')) return ok(STATS);
    if (u.startsWith('/api/admin/trials')) return ok(TRIALS);
    if (u.startsWith('/api/admin/billing/plans')) return ok(PLANS);
    return ok([]);
  });
}
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

beforeEach(() => serve());
afterEach(() => cleanup());

describe('Trials page: Convert to Paid', () => {
  it('asks for every trial, not only those ending in the future', async () => {
    render(<TrialsPage />);
    await screen.findByText('Running Co');
    expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).startsWith('/api/admin/trials?') && String(u).includes('scope=all'))).toBe(true);
  });

  it('is offered for a running trial and an expired one, not for a company that already pays', async () => {
    render(<TrialsPage />);
    await screen.findByText('Running Co');
    expect(within(rowOf('Running Co')).queryByRole('button', { name: /convert to paid/i })).not.toBeNull();
    expect(within(rowOf('Expired Co')).queryByRole('button', { name: /convert to paid/i })).not.toBeNull();
    expect(within(rowOf('Paying Co')).queryByRole('button', { name: /convert to paid/i })).toBeNull();
  });

  it('the Expired tab lists the expired trial, and Converted lists the paying one', async () => {
    render(<TrialsPage />);
    await screen.findByText('Running Co');
    fireEvent.click(screen.getByRole('button', { name: 'Expired' }));
    expect(screen.queryByText('Expired Co')).not.toBeNull();
    expect(screen.queryByText('Running Co')).toBeNull();
    expect(screen.queryByText('Paying Co')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Converted' }));
    expect(screen.queryByText('Paying Co')).not.toBeNull();
    expect(screen.queryByText('Expired Co')).toBeNull();
  });

  it('shows each row\'s trial state, not the company status', async () => {
    render(<TrialsPage />);
    await screen.findByText('Running Co');
    expect(within(rowOf('Expired Co')).queryByText('Expired')).not.toBeNull();
    expect(within(rowOf('Expired Co')).queryByText('Ended 9d ago')).not.toBeNull();
    expect(within(rowOf('Paying Co')).queryByText('Converted')).not.toBeNull();
    expect(within(rowOf('Running Co')).queryByText('Trial')).not.toBeNull();
    expect(within(rowOf('Running Co')).queryByText('6d left')).not.toBeNull();
  });
});

describe('Convert dialog', () => {
  it('lists only plans a customer can be converted to, with none preselected', async () => {
    render(<ConvertTrialModal companyId="e" companyName="Expired Co" onClose={vi.fn()} onConverted={vi.fn()} />);
    await screen.findByText('Starter');
    expect(screen.queryByText('Free Trial')).toBeNull();
    expect(screen.queryByText('Pay as you go')).toBeNull();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.some((r) => r.checked)).toBe(false);
    expect((screen.getByRole('button', { name: /^convert to paid$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('posts the plan the admin picked', async () => {
    const onConverted = vi.fn();
    render(<ConvertTrialModal companyId="e" companyName="Expired Co" onClose={vi.fn()} onConverted={onConverted} />);
    fireEvent.click(await screen.findByLabelText(/Professional/));
    const button = screen.getByRole('button', { name: /^convert to paid$/i }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(onConverted).toHaveBeenCalled());
    const post = vi.mocked(apiFetch).mock.calls.find(([u, i]) => String(u) === '/api/admin/trials/convert' && i?.method === 'POST')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ companyId: 'e', planId: 'p3' });
  });
});
