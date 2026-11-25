/**
 * Self-serve upgrade page copy: the card verification charge is stated with its amount (derived from
 * AUTH_VERIFICATION_CENTS, the amount mandateCheckout actually charges) and says plainly it is not refunded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import { apiFetch } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { AUTH_VERIFICATION_CENTS } from '@/modules/billing/services/mandateVerificationCharge';
import UpgradeFromTrialPage from '@/../pages/accounting/settings/billing/upgrade';

const mocked = apiFetch as unknown as ReturnType<typeof vi.fn>;

describe('upgrade from trial page', () => {
  beforeEach(() => {
    mocked.mockReset();
    mocked.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        onTrial: true, trialEndsAt: '2026-12-01T00:00:00.000Z', isPaid: false, currentPlanId: null,
        hasChargeableMandate: false, hasActiveMandate: false,
        plans: [{ id: 'p1', code: 'std', name: 'Standard', description: null, monthly_price_cents: 50000, currency: 'ZAR' }],
      },
    }), { status: 200 }));
  });

  it('states the verification charge amount and that it is not refunded, without an em dash', async () => {
    render(<UpgradeFromTrialPage />);
    await waitFor(() => expect(screen.getByText('Authorise payment and upgrade')).toBeDefined());

    const copy = screen.getByTestId('upgrade-charge-copy').textContent ?? '';
    expect(AUTH_VERIFICATION_CENTS).toBe(100);
    expect(copy).toContain(`verification charge of ${formatMoney(AUTH_VERIFICATION_CENTS / 100)}`);
    expect(copy).toContain('This charge is not refunded.');
    expect(copy).toContain('You are billed monthly from the day you upgrade.');
    expect(document.body.textContent ?? '').not.toContain('—');
  });
});
