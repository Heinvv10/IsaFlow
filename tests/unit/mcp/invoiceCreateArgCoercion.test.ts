/**
 * #1701 review round 1: the customer-invoice create tools no longer coerce what an agent sends.
 * - tax_rate false / "" / "  " / [] read as 0 by Number() and zero-rated the invoice: a number is required.
 * - a non-string invoice_date / due_date (a number, an array) was read as absent and became today: refused.
 * - unit_price null / "" / [] passed as 0, and a non-number quantity likewise: a number is required.
 * Each through BOTH tools, nothing created. And the full argument each tool hands createDraftCustomerInvoice
 * (taxRate, amountsAre, items[].vatType) is pinned, so dropping a forwarded field goes red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', () => ({
  createDraftCustomerInvoice: vi.fn(),
  InvoiceLineValidationError: class InvoiceLineValidationError extends Error {},
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ customerBelongsToCompany: vi.fn(async () => true) }));
vi.mock('@/lib/mcp/tools/externalRef', async (orig) => ({
  ...(await orig<typeof import('@/lib/mcp/tools/externalRef')>()),
  createReplayOrLock: vi.fn(async () => null), stampCreated: vi.fn(async () => undefined),
}));

import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { bulkCreateCustomerInvoicesTool } from '@/lib/mcp/tools/writeBulkCustomerInvoices';
import { createDraftInvoiceTool } from '@/lib/mcp/tools/writeInvoices';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { createReplayOrLock } from '@/lib/mcp/tools/externalRef';

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const ctx = { companyId: '11111111-1111-4111-8111-111111111111', userId: 'u1', scopes: ['write:invoices'] } as unknown as McpToolContext;
const create = createDraftCustomerInvoice as unknown as ReturnType<typeof vi.fn>;
const line = (over: Record<string, unknown> = {}) => ({ description: 'A', unit_price: 100, ...over });

/** One element through create_draft_invoice and through bulk_create_customer_invoices; the two refusal texts. */
async function both(element: Record<string, unknown>): Promise<[string, string]> {
  const single = await createDraftInvoiceTool.handler({ customer_id: CUSTOMER, idempotency_key: 'k', ...element }, ctx) as McpToolResult;
  const bulk = await bulkCreateCustomerInvoicesTool.handler({ idempotency_key: 'k', invoices: [{ customer_id: CUSTOMER, ...element }] }, ctx) as McpToolResult;
  return [single.isError ? single.content[0]!.text : 'ACCEPTED', bulk.isError ? bulk.content[0]!.text : 'ACCEPTED'];
}

beforeEach(() => { create.mockReset(); create.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1' }); });

describe('refused, not coerced, through both tools', () => {
  it.each([false, '', '  ', [], '15', {}])('tax_rate %j', async (v) => {
    expect(await both({ tax_rate: v, items: [line()] })).toEqual(['tax_rate must be a non-negative number', 'invoices[0].tax_rate must be a non-negative number']);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([['invoice_date', 20261120], ['invoice_date', ['2026-11-20']], ['due_date', 1]])('%s %j', async (key, v) => {
    expect(await both({ [key]: v, items: [line()] })).toEqual([`${key} must be a date (YYYY-MM-DD)`, `invoices[0].${key} must be a date (YYYY-MM-DD)`]);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([null, '', [], '100', true])('unit_price %j', async (v) => {
    expect(await both({ items: [line({ unit_price: v })] }))
      .toEqual(['items[0].unit_price must be a non-negative number', 'invoices[0].items[0].unit_price must be a non-negative number']);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([null, '', '2', [2]])('quantity %j', async (v) => {
    expect(await both({ items: [line({ quantity: v })] }))
      .toEqual(['items[0].quantity must be a positive number', 'invoices[0].items[0].quantity must be a positive number']);
    expect(create).not.toHaveBeenCalled();
  });

  it('a real 0 is still a rate, and an absent quantity is 1', async () => {
    expect(await both({ tax_rate: 0, items: [line()] })).toEqual(['ACCEPTED', 'ACCEPTED']);
    expect(create.mock.calls.map((c) => [(c[2] as { taxRate: unknown }).taxRate, (c[2] as { items: { quantity: number }[] }).items[0]!.quantity]))
      .toEqual([[0, 1], [0, 1]]);
  });
});

describe('what each tool hands the service', () => {
  const element = {
    invoice_date: '2026-11-20', amounts_are: 'inclusive',
    items: [line({ vat_type: 'exempt', quantity: 2 }), line({ description: 'B', unit_price: 50 })],
  };
  const expected = {
    clientId: CUSTOMER, invoiceDate: '2026-11-20', dueDate: undefined, taxRate: undefined, amountsAre: 'inclusive', notes: undefined, projectId: null,
    items: [
      { description: 'A', unitPrice: 100, quantity: 2, glAccountId: null, projectId: null, vatType: 'exempt' },
      { description: 'B', unitPrice: 50, quantity: 1, glAccountId: null, projectId: null },
    ],
  };

  it('create_draft_invoice', async () => {
    await createDraftInvoiceTool.handler({ customer_id: CUSTOMER, idempotency_key: 'k', ...element }, ctx);
    expect(create.mock.calls[0]![2]).toEqual(expected);
  });

  it('bulk_create_customer_invoices', async () => {
    await bulkCreateCustomerInvoicesTool.handler({ idempotency_key: 'k', invoices: [{ customer_id: CUSTOMER, ...element }] }, ctx);
    expect(create.mock.calls[0]![2]).toEqual(expected);
  });

  it('a legacy tax_rate is forwarded as given, no line type', async () => {
    await createDraftInvoiceTool.handler({ customer_id: CUSTOMER, idempotency_key: 'k', tax_rate: 15, items: [line()] }, ctx);
    expect(create.mock.calls[0]![2]).toMatchObject({ taxRate: 15, amountsAre: undefined, items: [{ description: 'A', unitPrice: 100, quantity: 1 }] });
    expect('vatType' in (create.mock.calls[0]![2] as { items: object[] }).items[0]!).toBe(false);
  });
});

describe('an idempotent replay (external_ref) compares the date only, as the bill tools do (pinned, #1701 round 1)', () => {
  it('a re-send with another vat_type or amounts_are is the same replay: date only, and the description says so', async () => {
    await createDraftInvoiceTool.handler({ customer_id: CUSTOMER, idempotency_key: 'k', external_system: 'sage', external_ref: 'INV-1',
      invoice_date: '2026-11-20', amounts_are: 'inclusive', items: [line({ vat_type: 'exempt' })] }, ctx);
    expect(vi.mocked(createReplayOrLock).mock.calls.at(-1)![3]).toEqual({ expect: { date: '2026-11-20' } });
    expect(createDraftInvoiceTool.description).toMatch(/compares the invoice date only, as the bill tools do: its lines, VAT types and amounts_are are not compared/);
  });
});
