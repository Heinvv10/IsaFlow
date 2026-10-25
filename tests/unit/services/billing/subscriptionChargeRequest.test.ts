/**
 * S-07e: the charge cron's payment request is recorded under the charge's own
 * reference, which app roles can read. A row an app role inserted first under
 * it is not the cron's: ON CONFLICT writes nothing, and that is logged at error
 * level rather than passed over in silence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ script: [] as unknown[][], texts: [] as string[], error: vi.fn() }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    h.texts.push(strings.join('?'));
    return h.script.shift() ?? [];
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: h.error } }));

import { recordChargePaymentRequest } from '@/modules/billing/services/subscriptionChargeRequest';

beforeEach(() => {
  h.script.length = 0;
  h.texts.length = 0;
  h.error.mockReset();
});

describe('recordChargePaymentRequest', () => {
  it('inserts the cron\'s row, completed when the charge already succeeded', async () => {
    h.script.push([{ id: 'pr-1' }]);
    await recordChargePaymentRequest('co-1', 'ch-1', 'sub_ref', 49900, true);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toMatch(/ON CONFLICT \(paystack_reference\) DO NOTHING\s+RETURNING id/);
    expect(h.error).not.toHaveBeenCalled();
  });

  it('accepts its own row from an earlier attempt under the same reference', async () => {
    h.script.push([], [{ purpose: 'subscription_charge', company_id: 'co-1', subscription_charge_id: 'ch-1' }]);
    await recordChargePaymentRequest('co-1', 'ch-1', 'sub_ref', 49900, false);
    expect(h.error).not.toHaveBeenCalled();
  });

  it.each([
    ['an invoice payment planted under it', { purpose: 'customer_invoice', company_id: 'co-2', subscription_charge_id: null }],
    ['another company\'s charge', { purpose: 'subscription_charge', company_id: 'co-2', subscription_charge_id: 'ch-1' }],
    ['another charge', { purpose: 'subscription_charge', company_id: 'co-1', subscription_charge_id: 'ch-9' }],
  ])('logs a reference already held by %s', async (_, row) => {
    h.script.push([], [row]);
    await recordChargePaymentRequest('co-1', 'ch-1', 'sub_ref', 49900, true);
    expect(h.error).toHaveBeenCalledWith(expect.stringMatching(/already holds another payment request/),
      expect.objectContaining({ chargeId: 'ch-1', heldBy: row }), 'BillingCron');
  });
});
