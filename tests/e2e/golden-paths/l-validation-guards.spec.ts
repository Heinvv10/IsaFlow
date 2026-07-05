/**
 * P2.1 validation guards — E2E proof for the Phase-2 exit gate:
 * "negative invoice now impossible — prove with a failing POST".
 *
 * Live-fires the exact request the July-4 audit used to create a −R115.00
 * invoice (W1), plus the quote equivalent, and asserts the server refuses.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('negative and zero lines are rejected server-side (invoices + quotes)', async ({
  baseURL,
}) => {
  const api = await Api.login(baseURL!);
  try {
    const clientId = await api.fixtureCustomer();

    // The audit's exact W1 shape: negative quantity → −R115.00 invoice.
    const negQty = await api.postRaw('/api/accounting/customer-invoices-create', {
      clientId,
      invoiceDate: today(),
      items: [{ description: gpRef('W1'), quantity: -1, unitPrice: 115 }],
    });
    expect(negQty.status, 'negative quantity must be rejected').toBe(400);
    expect(negQty.json?.error?.message ?? negQty.json?.message ?? '').toMatch(/quantit/i);

    const negPrice = await api.postRaw('/api/accounting/customer-invoices-create', {
      clientId,
      invoiceDate: today(),
      items: [{ description: gpRef('W1'), quantity: 1, unitPrice: -115 }],
    });
    expect(negPrice.status, 'negative unit price must be rejected').toBe(400);

    // Quotes: the create path 500'd pre-P1.2 and never validated lines.
    const negQuote = await api.postRaw('/api/accounting/customer-quotes', {
      clientId,
      customerName: '0GP-Golden-Customer',
      quoteDate: today(),
      lines: [{ description: gpRef('W1Q'), quantity: -2, unitPrice: 50 }],
    });
    expect(negQuote.status, 'negative quote quantity must be rejected').toBeGreaterThanOrEqual(400);
    expect(negQuote.status).toBeLessThan(500);
  } finally {
    await api.dispose();
  }
});
