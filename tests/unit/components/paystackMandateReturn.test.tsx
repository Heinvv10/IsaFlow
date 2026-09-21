/**
 * K-095 r5 LOW-4: the charged-but-unattached copy tells the payer to contact
 * support before trying again, and the only action offered was a link labelled
 * "Try again". When the reason is `authorisation_blocked` /
 * `already_active_other_code` the company already HAS an active mandate and
 * pages/api/billing/paystack/mandate/create.ts answers 400 ("Revoke it before
 * creating a new one") — so the retry it invites cannot succeed.
 *
 * Rendered, not grepped: the label is a conditional inside the failed branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const query: { ref?: string } = { ref: 'k095ref' };
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query }) }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import PaystackMandateReturn from '@/../pages/admin/billing/paystack/return';

const mocked = apiFetch as unknown as ReturnType<typeof vi.fn>;

function verifyAnswers(data: Record<string, unknown>) {
  mocked.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ data }),
  });
}

describe('Paystack mandate return page', () => {
  beforeEach(() => { mocked.mockReset(); });

  it('offers "Back to billing", not a retry, when the card was charged but nothing attached', async () => {
    verifyAnswers({ status: 'failed', mandateId: null, failureReason: 'authorisation_blocked' });

    render(<PaystackMandateReturn />);

    await waitFor(() => expect(screen.getByText('Authorisation failed')).toBeDefined());
    expect(screen.getByText(/Your card was charged/)).toBeDefined();
    expect(screen.getByText('Back to billing')).toBeDefined();
    expect(screen.queryByText('Try again')).toBeNull();
  });

  it('still offers "Try again" for a plain decline, which the create route will accept', async () => {
    verifyAnswers({ status: 'failed', mandateId: null });

    render(<PaystackMandateReturn />);

    await waitFor(() => expect(screen.getByText('Authorisation failed')).toBeDefined());
    expect(screen.getByText(/declined the authorisation/)).toBeDefined();
    expect(screen.getByText('Try again')).toBeDefined();
  });
});
