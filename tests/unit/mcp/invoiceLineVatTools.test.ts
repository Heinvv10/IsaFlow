/**
 * The MCP invoice tools and per-line VAT: create_draft_invoice / bulk_create_customer_invoices declare and carry a
 * line's `vat_type` (the service holds it to the contract), keep header `tax_rate` as the legacy input, state the rule,
 * and every new refusal reaches the agent as its registered code (bulk: named by element, the typed class kept).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', () => ({
  createDraftCustomerInvoice: vi.fn(),
  InvoiceLineValidationError: class InvoiceLineValidationError extends Error {},
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ customerBelongsToCompany: vi.fn(async () => true) }));

import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import { CUSTOMER_INVOICE_LINE_SCHEMA, parseCustomerInvoiceInput } from '@/lib/mcp/tools/customerInvoiceCreateArgs';
import { bulkCreateCustomerInvoicesTool } from '@/lib/mcp/tools/writeBulkCustomerInvoices';
import { createDraftInvoiceTool } from '@/lib/mcp/tools/writeInvoices';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
import { safeErrorText } from '@/lib/mcp/tools/toolHelpers';
import type { McpToolContext } from '@/lib/mcp/types';

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const ctx = { companyId: '11111111-1111-4111-8111-111111111111', userId: 'u1', scopes: ['write:invoices'] } as unknown as McpToolContext;
const create = createDraftCustomerInvoice as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { create.mockReset(); create.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1' }); });

describe('the line schema and its parse', () => {
  it('declares vat_type with the three document line types, and says the rate comes from the type', () => {
    const vt = CUSTOMER_INVOICE_LINE_SCHEMA.properties.vat_type;
    expect(vt.enum).toEqual(['standard', 'zero_rated', 'exempt']);
    expect(vt.description).toMatch(/rate comes from the type and the invoice date, never from the caller/);
  });

  it('carries vat_type as sent (the service refuses what it may not be); absent stays absent', () => {
    const p = parseCustomerInvoiceInput({ customer_id: CUSTOMER, items: [
      { description: 'A', unit_price: 1, vat_type: 'exempt' }, { description: 'B', unit_price: 1 }, { description: 'C', unit_price: 1, vat_type: 'luxury' },
    ] });
    if (typeof p === 'string') throw new Error(p);
    expect(p.items.map((i) => i.vatType)).toEqual(['exempt', undefined, 'luxury']);
    expect('vatType' in p.items[1]!).toBe(false);
  });

  it('a camelCase vatType is still an unknown key', () => {
    expect(parseCustomerInvoiceInput({ customer_id: CUSTOMER, items: [{ description: 'A', unit_price: 1, vatType: 'exempt' }] }))
      .toMatch(/^items\[0\] has "vatType", which is not a line field/);
  });

  it('both tools describe the rule and keep tax_rate as the legacy input', () => {
    for (const tool of [createDraftInvoiceTool, bulkCreateCustomerInvoicesTool]) {
      expect(tool.description).toMatch(/VAT is set per line by items\[\]\.vat_type/);
      expect(tool.description).toMatch(/a company not registered for VAT gets no VAT on any line/);
    }
    const single = createDraftInvoiceTool.inputSchema as { properties: Record<string, { description?: string }> };
    expect(single.properties.tax_rate!.description).toMatch(/^LEGACY, instead of items\[\]\.vat_type/);
  });
});

describe('the refusals reach the agent', () => {
  it('both codes are registered, so the message is shown verbatim', () => {
    expect(REFUSAL_CODES.has('INVOICE_LINE_VAT_REFUSED')).toBe(true);
    expect(REFUSAL_CODES.has('INVOICE_VAT_NOT_REGISTERED')).toBe(true);
    expect(safeErrorText(new InvoiceLineVatRefusal('items[0] cannot be no_vat'), 'generic')).toBe('items[0] cannot be no_vat');
    expect(safeErrorText(new InvoiceVatNotRegisteredRefusal('not registered'), 'generic')).toBe('not registered');
  });

  it('create_draft_invoice passes vat_type to the service and lets its refusal propagate (the savepoint unwinds)', async () => {
    create.mockRejectedValueOnce(new InvoiceLineVatRefusal('items[0]: "luxury" is not a VAT type'));
    await expect(createDraftInvoiceTool.handler({ customer_id: CUSTOMER, idempotency_key: 'k',
      items: [{ description: 'A', unit_price: 10, vat_type: 'luxury' }] }, ctx)).rejects.toBeInstanceOf(InvoiceLineVatRefusal);
    expect((create.mock.calls[0]![2] as { items: { vatType?: unknown }[] }).items[0]!.vatType).toBe('luxury');
  });

  it.each([
    ['INVOICE_LINE_VAT_REFUSED', new InvoiceLineVatRefusal('taxRate 14 is neither …'), InvoiceLineVatRefusal],
    ['INVOICE_VAT_NOT_REGISTERED', new InvoiceVatNotRegisteredRefusal('This company is not registered for VAT …'), InvoiceVatNotRegisteredRefusal],
  ] as const)('bulk: %s is re-thrown named by its element, the class kept', async (code, err, cls) => {
    create.mockResolvedValueOnce({ id: 'inv-1', invoiceNumber: 'INV-1' }).mockRejectedValueOnce(err);
    const thrown = await bulkCreateCustomerInvoicesTool.handler({ idempotency_key: 'k', invoices: [
      { customer_id: CUSTOMER, items: [{ description: 'A', unit_price: 10 }] },
      { customer_id: CUSTOMER, tax_rate: 14, items: [{ description: 'B', unit_price: 10 }] },
    ] }, ctx).then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(cls);
    expect((thrown as { code: string }).code).toBe(code);
    expect((thrown as Error).message).toBe(`invoices[1]: ${err.message}`);
  });
});
