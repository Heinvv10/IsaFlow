/**
 * R-181 (PR #618 review at 47c581ac0, M1): decideGatewayAllocation — the step that never settles
 * an invoice outside the ledger — reads the invoice under its row lock and hands allocationPlan
 * the row as read there. In CI: sql is mocked and withCustomerInvoiceLock runs its statement as a
 * pass-through that records it; the lock itself is proven by the r181 integration race test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  pending: '0',
  inLock: false,
  locked: [] as { text: string; values: unknown[] }[],
  all: [] as { text: string; values: unknown[] }[],
}));
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (h.inLock) h.locked.push({ text, values });
    h.all.push({ text, values });
    if (text.includes('FROM customer_invoices')) return Promise.resolve([h.row]);
    if (text.includes('customer_payment_allocations')) return Promise.resolve([{ pending: h.pending }]);
    return Promise.resolve([]);
  },
  withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceLock', () => ({
  withCustomerInvoiceLock: async (_fn: string, _subject: string, run: () => Promise<unknown>) => {
    h.inLock = true;
    try { return await run(); } finally { h.inLock = false; }
  },
}));

// FX PR0: the foreign-currency test is a nested SQL fragment; a marker stands in for it here,
// and fx-pr0-rails.int.test.ts runs the real one.
vi.mock('@/modules/accounting/services/shared/documentCurrency', () => ({ invoiceForeignCurrencySql: () => 'FOREIGN?' }));

import { decideGatewayAllocation } from '@/modules/accounting/services/ar/gatewayReceiptAllocation';

const CO = '33333333-3333-4333-8333-333333333333';
const INV = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const row = (change: Record<string, unknown> = {}) =>
  ({ locked_total: '115.00', amount_paid: '0', status: 'sent', deleted_at: null, client_id: CUSTOMER, foreign_currency: false, ...change });

beforeEach(() => { h.row = row(); h.pending = '0'; h.locked.length = 0; h.all.length = 0; });

describe('decideGatewayAllocation', () => {
  it('reads the invoice FOR UPDATE, scoped by company, inside the invoice lock', async () => {
    await decideGatewayAllocation(CO, INV, 115, 'r181_alloc');
    expect(h.locked).toHaveLength(1);
    expect(h.locked[0]!.text).toMatch(/FROM customer_invoices[\s\S]*company_id = \?::UUID[\s\S]*FOR UPDATE/);
    expect(h.locked[0]!.values).toEqual(['FOREIGN?', INV, CO]);
  });

  it("the draft-receipt deduction counts only DRAFT receipts, of this company, against this invoice", async () => {
    await decideGatewayAllocation(CO, INV, 115, 'r181_alloc');
    const pendingRead = h.all.find((c) => c.text.includes('customer_payment_allocations'))!;
    expect(pendingRead.text).toMatch(/cp\.status = 'draft'/);
    expect(pendingRead.text).toMatch(/cpa\.invoice_id = \?::UUID[\s\S]*cp\.company_id = \?::UUID/);
    expect(pendingRead.values).toEqual([INV, CO]);
  });

  it('a draft invoice takes nothing: invoice_draft', async () => {
    h.row = row({ status: 'draft' });
    expect(await decideGatewayAllocation(CO, INV, 115, 'r181_alloc'))
      .toMatchObject({ allocated: 0, invoiceBlock: 'invoice_draft', overpaid: false, status: 'draft' });
  });

  it('a soft-deleted invoice takes nothing: invoice_deleted', async () => {
    h.row = row({ deleted_at: '2026-10-02' });
    expect(await decideGatewayAllocation(CO, INV, 115, 'r181_alloc'))
      .toMatchObject({ allocated: 0, invoiceBlock: 'invoice_deleted', deleted: true });
  });

  it('draft receipts already claim R20 of R115: a R115 receipt allocates R95, overpaid', async () => {
    h.pending = '20.00';
    expect(await decideGatewayAllocation(CO, INV, 115, 'r181_alloc'))
      .toMatchObject({ allocated: 95, invoiceBlock: null, overpaid: true });
  });

  it("the caller's hold (unapplied_currency) allocates nothing", async () => {
    expect(await decideGatewayAllocation(CO, INV, 115, 'r181_alloc', 'unapplied_currency'))
      .toMatchObject({ allocated: 0, invoiceBlock: 'unapplied_currency', overpaid: false });
  });

  it('a foreign-currency invoice is held, never allocated; the caller\'s own hold still names itself', async () => {
    h.row = row({ foreign_currency: true });
    expect(await decideGatewayAllocation(CO, INV, 115, 'fx_alloc'))
      .toMatchObject({ allocated: 0, invoiceBlock: 'invoice_foreign_currency', overpaid: false });
    expect(await decideGatewayAllocation(CO, INV, 115, 'fx_alloc', 'unapplied_currency'))
      .toMatchObject({ allocated: 0, invoiceBlock: 'unapplied_currency' });
  });

  it('returns the customer as read under the lock', async () => {
    const SURVIVOR = '55555555-5555-4555-8555-555555555555';
    h.row = row({ client_id: SURVIVOR });
    expect((await decideGatewayAllocation(CO, INV, 115, 'r181_alloc')).clientId).toBe(SURVIVOR);
  });
});
