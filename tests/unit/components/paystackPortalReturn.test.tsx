/**
 * R-181 (PR #618 LOW-2): the portal's Paystack return page states the amount actually banked,
 * names the invoice only when the money was applied to it, and stops polling a payment that stays
 * pending after a bounded number of tries with a neutral "still confirming" state, never an error
 * (verify's per-IP rate limit used to end an endless poll on "Verification failed (429)").
 *
 * Rendered, with the verify API stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

const query: { ref?: string } = { ref: 'r181ref' };
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query, asPath: '/portal/payments/paystack/return?ref=r181ref', replace: vi.fn() }),
}));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import PaystackReturnPage from '@/../pages/portal/payments/paystack/return';

const mocked = apiFetch as unknown as ReturnType<typeof vi.fn>;
const answer = (data: Record<string, unknown>, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ data }) });

describe('Paystack portal return page', () => {
  beforeEach(() => { mocked.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('completed and applied: the banked amount, against the invoice', async () => {
    mocked.mockResolvedValue(answer({ status: 'completed', amountCents: 5000, appliedToInvoice: true, invoiceNumber: 'INV-181' }));
    render(<PaystackReturnPage />);
    await waitFor(() => expect(screen.getByText('Payment received')).toBeDefined());
    expect(screen.getByText(/50,00 has been received against invoice INV-181\./)).toBeDefined();
  });

  it('completed but not applied (invoice not open for payment): no invoice wording', async () => {
    mocked.mockResolvedValue(answer({ status: 'completed', amountCents: 11500, appliedToInvoice: false, invoiceNumber: 'INV-181' }));
    render(<PaystackReturnPage />);
    await waitFor(() => expect(screen.getByText('Payment received')).toBeDefined());
    expect(screen.getByText(/115,00 has been received\./)).toBeDefined();
    expect(screen.queryByText(/against invoice/)).toBeNull();
  });

  it('pending on every try: stops after 10 polls on a neutral "still confirming" state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocked.mockResolvedValue(answer({ status: 'pending', amountCents: 11500 }));
    const { unmount } = render(<PaystackReturnPage />);
    try {
      for (let i = 0; i < 15; i += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      }
      expect(mocked).toHaveBeenCalledTimes(10);
      await waitFor(() => expect(screen.getByText('Still confirming your payment')).toBeDefined());
      expect(screen.queryByText(/couldn.t verify/)).toBeNull();
    } finally {
      unmount(); // stops a poll that would otherwise outlive the test
    }
  });

  it('a rate-limited verify (429) ends on the neutral state, not an error', async () => {
    mocked.mockResolvedValue(answer({}, 429));
    render(<PaystackReturnPage />);
    await waitFor(() => expect(screen.getByText('Still confirming your payment')).toBeDefined());
    expect(screen.queryByText(/Verification failed/)).toBeNull();
  });
});
