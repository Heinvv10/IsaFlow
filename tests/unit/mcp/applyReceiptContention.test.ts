/**
 * apply_receipt_to_invoice answers a HELD ROW as every tool answers a retryable lock error (review round 2, LOW 4):
 * thrown, so the registry's savepoint rolls the call back and `thrownToolErrorText` keeps the "retry" wording — not a
 * plain refusal. The receipt credit lock (ar/customerCreditLock) refuses this way when a refund or another write of
 * the customer's cash holds the row. A refusal about the books stays a tool error.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/receiptApplicationService', () => ({ planReceiptApplication: vi.fn(), applyReceiptPlan: vi.fn() }));

import { planReceiptApplication } from '@/modules/accounting/services/ar/receiptApplicationService';
import { applyReceiptToInvoiceTool } from '@/lib/mcp/tools/writeApplyReceipt';
import { thrownToolErrorText } from '@/lib/mcp/thrownToolErrorText';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';
import { CustomerVoidCreditRefusal } from '@/modules/accounting/services/ar/customerVoidCredit';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx = () => ({ userId: '99999999-9999-4999-8999-999999999999', companyId: '11111111-1111-4111-8111-111111111111',
  scopes: ['write:invoices'], tokenJti: 'jti', oauthAppId: null }) as McpToolContext;
const args = { payment_id: '33333333-3333-4333-8333-333333333333', idempotency_key: 'k1',
  allocations: [{ invoice_id: '44444444-4444-4444-8444-444444444444', amount: 100 }] };

describe('apply_receipt_to_invoice — contention vs refusal', () => {
  it('a held customer row is THROWN, and the agent is told to retry', async () => {
    const held = new PaymentLockTimeoutError('c', 'A refund or another change to this customer\'s on-account credit is in progress — retry in a moment.');
    vi.mocked(planReceiptApplication).mockRejectedValueOnce(held);
    const err = await applyReceiptToInvoiceTool.handler(args, ctx()).catch((e: unknown) => e);
    expect(err).toBe(held);
    expect(thrownToolErrorText('apply_receipt_to_invoice', err)).toMatch(/retry in a moment/);
  });
  it('the credit refusal itself stays a tool error, dry run and live alike', async () => {
    for (const dryRun of [true, false]) {
      vi.mocked(planReceiptApplication).mockRejectedValueOnce(new CustomerVoidCreditRefusal('Applying R 100.00 of this receipt would leave Acme owing the company'));
      const r = await applyReceiptToInvoiceTool.handler({ ...args, ...(dryRun ? { dry_run: true } : {}) }, ctx());
      expect({ isError: r.isError, text: r.content[0]!.text }).toEqual({ isError: true, text: expect.stringMatching(/^Applying R/) });
    }
  });
});
