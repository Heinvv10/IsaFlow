/**
 * Golden path (a): quote → accept → convert to invoice → PDF.
 *
 * Was EXPECTED FAIL at baseline — July-4 audit H2: quoteService inserted
 * line_number/line_total/account_id but customer_quote_lines has
 * sort_order/amount/gl_account_id → every create 500s; the feature had never
 * worked. Flipped to a plain test by P1.2: PR #192 aligned the quote
 * services with the schema; the residual convert crash (mapQuote fed
 * String(pg Date) back into the conversion INSERT → `time zone "gmt+0200"
 * not recognized`) is fixed alongside this flip.
 */
import { test, expect } from '@playwright/test';
import { Api, gpRef, today } from './_api';

test('quote: create → accept → convert to invoice → PDF renders', async ({ baseURL }) => {
  const api = await Api.login(baseURL!);
  try {
    const customers = await api.get<any[]>('/api/accounting/customers?limit=1');
    const client = customers[0];

    // Create quote (fails with 500 today).
    const ref = gpRef('QTE');
    const quote = await api.post<any>('/api/accounting/customer-quotes', {
      clientId: client.id,
      customerName: client.name,
      quoteDate: today(),
      notes: ref,
      lines: [{ description: ref, quantity: 2, unitPrice: 50, taxRate: 15 }],
    });
    expect(quote.id).toBeTruthy();
    expect(Number(quote.total)).toBeCloseTo(115, 2);

    // Accept.
    await api.post('/api/accounting/customer-quotes-action', {
      id: quote.id,
      action: 'accept',
    });

    // Convert to invoice.
    const converted = await api.post<any>('/api/accounting/customer-quotes-action', {
      id: quote.id,
      action: 'convert',
    });
    const invoiceId = converted.invoiceId ?? converted.id;
    expect(invoiceId, 'convert must return the new invoice').toBeTruthy();

    // Invoice exists and carries the quote's value.
    const invoice = await api.get<any>(
      `/api/accounting/customer-invoices-detail?id=${invoiceId}`,
    );
    expect(Number(invoice.total_amount)).toBeCloseTo(115, 2);

    // PDF renders.
    const pdf = await api.getBinary(`/api/accounting/invoice-pdf?invoiceId=${invoiceId}`);
    expect(pdf.status).toBe(200);
    expect(pdf.contentType).toContain('pdf');
    expect(pdf.bytes).toBeGreaterThan(1000);
  } finally {
    await api.dispose();
  }
});
