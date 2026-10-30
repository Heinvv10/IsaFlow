/**
 * The AR / AP age analysis report defaults its "as at" date to the SAST day, the date Home's ageing
 * uses, not to the browser's local day. A browser in UTC at 22:30 UTC is still on the 27th while
 * South Africa is on the 28th, and the two figures then differ by a day of ageing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ARAgingPage from '../../../pages/accounting/reports/ar-aging';
import APAgingPage from '../../../pages/accounting/reports/ap-aging';
import { AGING_BREAKDOWN_LABELS } from '@/modules/accounting/services/reports/dashboardOpenBook';

useApiJsonOverMock();

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T22:30:00Z'));
});
afterAll(() => { vi.useRealTimers(); process.env.TZ = ORIGINAL_TZ; });
afterEach(cleanup);

describe.each([['AR', ARAgingPage, 'reports-ar-aging'], ['AP', APAgingPage, 'reports-ap-aging']] as const)(
  '%s age analysis', (_side, Page, endpoint) => {
    it('asks for the SAST day (28 Oct) when it is still the 27th in the browser', async () => {
      vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response(JSON.stringify({
        success: true, data: { rows: [], summary: [], as_at_date: '2026-10-28' },
      }), { status: 200 }));
      render(<Page />);
      await waitFor(() => expect(apiFetch).toHaveBeenCalled());
      const url = String(vi.mocked(apiFetch).mock.calls.find(([u]) => String(u).includes(endpoint))![0]);
      expect(url).toContain('as_at_date=2026-10-28');
    });
  },
);

describe.each([['AR', ARAgingPage], ['AP', APAgingPage]] as const)('%s age analysis bucket labels', (_side, Page) => {
  it('are the ageing donut\'s labels, character for character (en dash included)', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { rows: [], summary: ['current', '1-30', '31-60', '61-90', '90+'].map((bucket) => ({ bucket, count: 0, total: 0 })), as_at_date: '2026-10-28' },
    }), { status: 200 }));
    render(<Page />);
    for (const label of AGING_BREAKDOWN_LABELS.slice(0, 5)) {
      expect((await screen.findAllByText(label, { exact: true })).length, label).toBeGreaterThan(0);
    }
  });
});
