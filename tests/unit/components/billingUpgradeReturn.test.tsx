/**
 * Self-serve upgrade return page: verify the mandate (POST, ref in the body), and only once it is active
 * convert the company (POST convert with the plan from the query). A decline or a failed convert never
 * reports success, and a decline never calls convert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const query: { ref?: string; plan?: string } = {};
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import { apiFetch } from '@/lib/apiFetch';
import UpgradeReturnPage from '@/../pages/accounting/settings/billing/upgrade/return';

const mocked = apiFetch as unknown as ReturnType<typeof vi.fn>;
const PLAN = '33333333-3333-4333-8333-333333333333';

function answers(status: number, body: Record<string, unknown>) {
  mocked.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

describe('upgrade return page', () => {
  beforeEach(() => {
    mocked.mockReset();
    query.ref = 'auth_ref_1';
    query.plan = PLAN;
  });

  it('verifies, then converts with the plan from the link, then shows the first charge date', async () => {
    answers(200, { success: true, data: { status: 'active', mandateId: 'm1' } });
    answers(200, { success: true, data: { firstChargeAt: '2026-12-24T00:00:00.000Z', alreadyConverted: false } });

    render(<UpgradeReturnPage />);

    await waitFor(() => expect(screen.getByText('Your company is upgraded')).toBeDefined());
    const [vUrl, vInit] = mocked.mock.calls[0] as [string, RequestInit];
    expect(vUrl).toBe('/api/billing/paystack/mandate/verify');
    expect(vInit.method).toBe('POST');
    expect(JSON.parse(String(vInit.body))).toEqual({ ref: 'auth_ref_1' });
    const [cUrl, cInit] = mocked.mock.calls[1] as [string, RequestInit];
    expect(cUrl).toBe('/api/billing/upgrade/convert');
    expect(cInit.method).toBe('POST');
    expect(JSON.parse(String(cInit.body))).toEqual({ planId: PLAN });
  });

  it('a declined authorisation never converts and says the trial continues', async () => {
    answers(200, { success: true, data: { status: 'failed', mandateId: null } });

    render(<UpgradeReturnPage />);

    await waitFor(() => expect(screen.getByText('Authorisation failed')).toBeDefined());
    expect(screen.getByText(/still on its trial/)).toBeDefined();
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it('a refused convert (no mandate on file) shows the server sentence, not success', async () => {
    answers(200, { success: true, data: { status: 'active', mandateId: 'm1' } });
    answers(409, { success: false, error: { code: 'CONFLICT', message: 'Authorise a payment method before upgrading.' } });

    render(<UpgradeReturnPage />);

    await waitFor(() => expect(screen.getByText('The upgrade could not be completed')).toBeDefined());
    expect(screen.getByText('Authorise a payment method before upgrading.')).toBeDefined();
    expect(screen.queryByText('Your company is upgraded')).toBeNull();
  });

  it('a link without its plan or reference calls nothing', async () => {
    delete query.plan;

    render(<UpgradeReturnPage />);

    await waitFor(() => expect(screen.getByText('The upgrade could not be completed')).toBeDefined());
    expect(mocked).not.toHaveBeenCalled();
  });
});
