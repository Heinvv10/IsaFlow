// PR #1367 review: an internal (demo) trial company stays in the Trials table,
// so an admin can see and extend it, marked "Internal"; a live one has no badge.
// The counts leave internal companies out (summariseTrials, pinned here too).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));

import { apiFetch } from '@/lib/apiFetch';
import TrialsPage from '../../../pages/admin/trials';
import { summariseTrials, type TrialCompany } from '@/modules/admin/services/trialQueries';

useApiJsonOverMock();
afterEach(cleanup);
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const row = (id: string, name: string, internal: boolean): TrialCompany => ({
  id, name, plan_name: null, trial_ends_at: '2026-11-20T00:00:00Z', trial_started_at: '2026-10-20T00:00:00Z',
  user_count: 1, status: 'active', trial_state: 'active', days_left: 6, converted_at: null, internal,
});
const STATS = { total_trials: 1, active_trials: 1, expiring_this_week: 1, expired_unpaid: 0, converted_this_month: 0, conversion_rate_percent: 0 };

describe('Trials table: internal companies', () => {
  it('lists the demo company with an "Internal" badge, and a live company without one', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) =>
      ok(String(url).startsWith('/api/admin/trials/stats') ? STATS : [row('l', 'Live Co', false), row('m', 'Demo Co', true)]));
    render(<TrialsPage />);
    const demo = (await screen.findByText('Demo Co')).closest('td')!;
    expect(demo.textContent).toBe('Demo CoInternal');
    expect(screen.getByText('Live Co').closest('td')!.textContent).toBe('Live Co');
  });

  it('every count leaves the internal company out', () => {
    const stats = summariseTrials([row('l', 'Live Co', false), row('m', 'Demo Co', true)], new Date('2026-11-14T10:00:00Z'));
    expect(stats).toMatchObject({ total_trials: 1, active_trials: 1, expiring_this_week: 1 });
  });
});
