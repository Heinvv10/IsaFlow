/**
 * bulk_create_supplier_invoices / bulk_create_customer_invoices.
 *
 * What is worth pinning:
 *
 *  - the batch is ALL OR NOTHING. A failure part-way through must THROW, not
 *    return a tool error: only a throw reaches the registry's savepoint, and a
 *    returned error RELEASES it and commits the elements already written.
 *  - every element is parsed and every id ownership-checked BEFORE the first
 *    write, with the offending element's INDEX, so a 100-invoice batch never
 *    has to be bisected by hand.
 *  - ownership is checked over the DISTINCT ids, not once per element.
 *  - the per-element payload is the single tool's payload — the two share
 *    `invoiceCreateArgs`, so a refusal reads the same from either.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  createSupplierInvoice: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', () => ({
  createDraftCustomerInvoice: vi.fn(),
  InvoiceLineValidationError: class InvoiceLineValidationError extends Error {},
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  supplierBelongsToCompany: vi.fn(),
  customerBelongsToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));

import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import {
  supplierBelongsToCompany,
  customerBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { bulkCreateSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkInvoices';
import { bulkCreateCustomerInvoicesTool } from '@/lib/mcp/tools/writeBulkCustomerInvoices';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER_A = '55555555-5555-4555-8555-555555555555';
const SUPPLIER_B = '55555555-5555-4555-8555-555555555556';
const CUSTOMER = '99999999-9999-4999-8999-999999999999';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '44444444-4444-4444-8444-444444444444',
    companyId: COMPANY,
    scopes: ['write:invoices'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}

function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

const LINE = { description: 'Fibre spool', quantity: 2, unit_price: 500 };

function bill(over: Record<string, unknown> = {}) {
  return {
    supplier_id: SUPPLIER_A,
    invoice_number: 'INV-9001',
    invoice_date: '2026-06-30',
    lines: [LINE],
    ...over,
  };
}

function madeInvoice(n: number) {
  return {
    id: `id-${n}`,
    invoiceNumber: `INV-${n}`,
    supplierId: SUPPLIER_A,
    invoiceDate: '2026-06-30',
    totalAmount: 1150,
    status: 'draft',
  };
}

describe('bulk_create_supplier_invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(supplierBelongsToCompany).mockResolvedValue(true);
    vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
    let n = 0;
    vi.mocked(createSupplierInvoice).mockImplementation(async () => madeInvoice(++n) as never);
  });

  it('creates every element and reports them with their index', async () => {
    const r = await bulkCreateSupplierInvoicesTool.handler({
      invoices: [bill(), bill({ invoice_number: 'INV-9002' })],
      ...KEY,
    }, ctx());
    const out = parseOk(r);
    expect(out.created_count).toBe(2);
    expect((out.invoices as Record<string, unknown>[]).map((i) => i.index)).toEqual([0, 1]);
    expect(createSupplierInvoice).toHaveBeenCalledTimes(2);
  });

  it('stamps the BULK tool name, not the single one', async () => {
    await bulkCreateSupplierInvoicesTool.handler({ invoices: [bill()], ...KEY }, ctx());
    const opts = vi.mocked(createSupplierInvoice).mock.calls[0]![3] as { postingAgent?: string };
    expect(opts.postingAgent).toContain('bulk_create_supplier_invoices');
  });

  it('names the offending ELEMENT index and writes nothing', async () => {
    const r = await bulkCreateSupplierInvoicesTool.handler({
      invoices: [bill(), bill({ invoice_number: 'INV-9002', invoice_date: 'not-a-date' })],
      ...KEY,
    }, ctx());
    expect(errText(r)).toBe('invoices[1].invalid invoice_date');
    expect(createSupplierInvoice).not.toHaveBeenCalled();
    expect(supplierBelongsToCompany).not.toHaveBeenCalled();
  });

  it('carries the single tool’s line-index wording through', async () => {
    const r = await bulkCreateSupplierInvoicesTool.handler({
      invoices: [bill({ lines: [LINE, { ...LINE, quantity: 0 }] })],
      ...KEY,
    }, ctx());
    expect(errText(r)).toBe('invoices[0].lines[1].quantity must be a positive number');
    expect(createSupplierInvoice).not.toHaveBeenCalled();
  });

  // CONTRACT CHANGE (2026-09-07): a repeat used to refuse the whole call. It is
  // now a SKIP — one bill sent twice is a fact about the data, not a fault in
  // the request, and refusing 99 good bills over it is what made the Velocity
  // reload renumber 14 Sage pairs by hand. Detail in
  // tests/unit/mcp/bulkCreateDuplicateSkip.test.ts.
  it('skips the same supplier invoice_number twice in one batch, keeping the first', async () => {
    const r = await bulkCreateSupplierInvoicesTool.handler({
      invoices: [bill(), bill()],
      ...KEY,
    }, ctx());
    const out = parseOk(r);
    expect(out.created_count).toBe(1);
    expect(createSupplierInvoice).toHaveBeenCalledTimes(1);
    expect(out.skipped).toHaveLength(1);
    expect((out.skipped as { index: number }[])[0]!.index).toBe(1);
  });

  it('allows the same invoice_number for DIFFERENT suppliers', async () => {
    const r = await bulkCreateSupplierInvoicesTool.handler({
      invoices: [bill(), bill({ supplier_id: SUPPLIER_B })],
      ...KEY,
    }, ctx());
    expect(parseOk(r).created_count).toBe(2);
  });

  it('checks ownership over the DISTINCT ids, before any write', async () => {
    await bulkCreateSupplierInvoicesTool.handler({
      invoices: [
        bill({ lines: [{ ...LINE, gl_account_id: ACCOUNT }] }),
        bill({ invoice_number: 'INV-9002', lines: [{ ...LINE, gl_account_id: ACCOUNT }] }),
      ],
      ...KEY,
    }, ctx());
    // Two elements, one supplier and one account between them.
    expect(supplierBelongsToCompany).toHaveBeenCalledTimes(1);
    expect(accountsBelongToCompany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(accountsBelongToCompany).mock.calls[0]![1]).toEqual([ACCOUNT]);
  });

  it('refuses a foreign supplier generically, writing nothing', async () => {
    vi.mocked(supplierBelongsToCompany).mockResolvedValue(false);
    const r = await bulkCreateSupplierInvoicesTool.handler({ invoices: [bill()], ...KEY }, ctx());
    expect(errText(r)).toBe('Not found');
    expect(createSupplierInvoice).not.toHaveBeenCalled();
  });

  it('THROWS when an element fails mid-batch, so the savepoint discards the rest', async () => {
    vi.mocked(createSupplierInvoice)
      .mockResolvedValueOnce(madeInvoice(1) as never)
      .mockRejectedValueOnce(new Error('unit price must not be negative'));
    await expect(bulkCreateSupplierInvoicesTool.handler({
      invoices: [bill(), bill({ invoice_number: 'INV-9002' })],
      ...KEY,
    }, ctx())).rejects.toThrow('invoices[1]: unit price must not be negative');
  });

  it('refuses more than 100 elements', async () => {
    const r = await bulkCreateSupplierInvoicesTool.handler({
      invoices: Array.from({ length: 101 }, (_, i) => bill({ invoice_number: `INV-${i}` })),
      ...KEY,
    }, ctx());
    expect(errText(r)).toContain('the maximum is 100');
    expect(createSupplierInvoice).not.toHaveBeenCalled();
  });

  it('refuses an empty or non-array batch', async () => {
    for (const invoices of [[], 'nope', undefined]) {
      const r = await bulkCreateSupplierInvoicesTool.handler({ invoices, ...KEY }, ctx());
      expect(errText(r)).toBe('invoices must be a non-empty array');
    }
  });
});

describe('bulk_create_customer_invoices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(customerBelongsToCompany).mockResolvedValue(true);
    let n = 0;
    vi.mocked(createDraftCustomerInvoice).mockImplementation(
      async () => ({ id: `ci-${++n}`, invoiceNumber: `INV-${n}` }) as never,
    );
  });

  const inv = (over: Record<string, unknown> = {}) => ({
    customer_id: CUSTOMER,
    items: [{ description: 'Install', unit_price: 1000 }],
    ...over,
  });

  it('creates every element and reports them with their index', async () => {
    const r = await bulkCreateCustomerInvoicesTool.handler({
      invoices: [inv(), inv()],
      ...KEY,
    }, ctx());
    const out = parseOk(r);
    expect(out.created_count).toBe(2);
    expect((out.invoices as Record<string, unknown>[])[1]!.index).toBe(1);
  });

  it('names the offending element index and writes nothing', async () => {
    const r = await bulkCreateCustomerInvoicesTool.handler({
      invoices: [inv(), inv({ items: [{ description: '', unit_price: 5 }] })],
      ...KEY,
    }, ctx());
    expect(errText(r)).toBe('invoices[1].items[0].description is required');
    expect(createDraftCustomerInvoice).not.toHaveBeenCalled();
  });

  it('checks each DISTINCT customer once, before any write', async () => {
    await bulkCreateCustomerInvoicesTool.handler({ invoices: [inv(), inv()], ...KEY }, ctx());
    expect(customerBelongsToCompany).toHaveBeenCalledTimes(1);
  });

  it('refuses a foreign customer generically', async () => {
    vi.mocked(customerBelongsToCompany).mockResolvedValue(false);
    const r = await bulkCreateCustomerInvoicesTool.handler({ invoices: [inv()], ...KEY }, ctx());
    expect(errText(r)).toBe('Not found');
    expect(createDraftCustomerInvoice).not.toHaveBeenCalled();
  });

  it('refuses a negative unit_price and a non-positive quantity at parse time', async () => {
    // createDraftCustomerInvoice throws on both, so no negative invoice is ever
    // created either way — but refused HERE it names the element and the line
    // before the first INSERT, instead of surfacing after earlier elements were
    // written and had to be discarded.
    const bad = await bulkCreateCustomerInvoicesTool.handler({
      invoices: [inv(), inv({ items: [{ description: 'x', unit_price: -5000 }] })],
      ...KEY,
    }, ctx());
    expect(errText(bad)).toBe('invoices[1].items[0].unit_price must be a non-negative number');

    const zeroQty = await bulkCreateCustomerInvoicesTool.handler({
      invoices: [inv({ items: [{ description: 'x', unit_price: 10, quantity: 0 }] })],
      ...KEY,
    }, ctx());
    expect(errText(zeroQty)).toBe('invoices[0].items[0].quantity must be a positive number');
    expect(createDraftCustomerInvoice).not.toHaveBeenCalled();
  });

  it('THROWS when an element fails mid-batch', async () => {
    vi.mocked(createDraftCustomerInvoice)
      .mockResolvedValueOnce({ id: 'ci-1' } as never)
      .mockRejectedValueOnce(new Error('boom'));
    await expect(bulkCreateCustomerInvoicesTool.handler({
      invoices: [inv(), inv()],
      ...KEY,
    }, ctx())).rejects.toThrow('invoices[1]:');
  });
});
