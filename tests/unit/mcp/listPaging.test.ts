/**
 * list_customers, list_suppliers and list_invoices must reach every row.
 *
 * They were capped at 200/200/100 with no offset and no cursor — row 201 of a
 * 4,000-supplier migration was unreachable through any tool, so an agent
 * reconciling a Sage crosswalk could not finish it. Each now takes `offset`
 * and answers `next_offset` (null on the last page), the contract
 * list_supplier_invoices already uses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  listCustomers: vi.fn(),
  listSuppliers: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceReadService', () => ({
  listCustomerInvoices: vi.fn(),
  getCustomerInvoiceDetail: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/quoteService', () => ({ getQuotes: vi.fn() }));

import { listCustomers, listSuppliers } from '@/modules/accounting/services/core/contactDirectoryService';
import { listCustomerInvoices } from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { listCustomersTool, listSuppliersTool } from '@/lib/mcp/tools/contacts';
import { listInvoicesTool } from '@/lib/mcp/tools/invoices';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const ctx = { companyId: COMPANY_ID, userId: 'u-1' } as McpToolContext;

function rows(n: number, prefix = 'r'): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

function body(result: { content: { text: string }[]; isError?: boolean }): Record<string, unknown> {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => vi.clearAllMocks());

describe('list_customers — paging', () => {
  it('asks for one row more than the page, and offers next_offset when it came back', async () => {
    vi.mocked(listCustomers).mockResolvedValue(rows(51));
    const out = body(await listCustomersTool.handler({ limit: 50, offset: 100 }, ctx));

    expect(listCustomers).toHaveBeenCalledWith(COMPANY_ID, null, { limit: 51, offset: 100 });
    expect(out.customers).toHaveLength(50);
    expect(out.next_offset).toBe(150);
  });

  it('answers next_offset null on the last page', async () => {
    vi.mocked(listCustomers).mockResolvedValue(rows(7));
    const out = body(await listCustomersTool.handler({ limit: 50, offset: 200 }, ctx));

    expect(out.customers).toHaveLength(7);
    expect(out.next_offset).toBeNull();
  });

  it('defaults to the old 200-row page from offset 0, so an unpaged caller sees what it saw', async () => {
    vi.mocked(listCustomers).mockResolvedValue(rows(3));
    await listCustomersTool.handler({ search: 'brit' }, ctx);

    expect(listCustomers).toHaveBeenCalledWith(COMPANY_ID, 'brit', { limit: 201, offset: 0 });
  });

  it('refuses a negative or fractional offset rather than guessing', async () => {
    for (const offset of [-1, 1.5, 'ten']) {
      const r = await listCustomersTool.handler({ offset }, ctx);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe('offset must be a non-negative integer');
    }
    expect(listCustomers).not.toHaveBeenCalled();
  });
});

describe('list_suppliers — paging', () => {
  it('passes offset through and answers next_offset from the total', async () => {
    vi.mocked(listSuppliers).mockResolvedValue({ suppliers: rows(25), total: 60 });
    const out = body(await listSuppliersTool.handler({ limit: 25, offset: 25 }, ctx));

    expect(listSuppliers).toHaveBeenCalledWith(COMPANY_ID, { search: null, limit: 25, offset: 25 });
    expect(out.total).toBe(60);
    expect(out.next_offset).toBe(50);
  });

  it('answers next_offset null when the page reaches the total', async () => {
    vi.mocked(listSuppliers).mockResolvedValue({ suppliers: rows(10), total: 60 });
    const out = body(await listSuppliersTool.handler({ limit: 25, offset: 50 }, ctx));

    expect(out.next_offset).toBeNull();
  });
});

describe('list_invoices — paging', () => {
  it('passes offset through and answers next_offset from the total', async () => {
    vi.mocked(listCustomerInvoices).mockResolvedValue({ invoices: rows(100), total: 250 });
    const out = body(await listInvoicesTool.handler({ limit: 100, offset: 100 }, ctx));

    expect(listCustomerInvoices).toHaveBeenCalledWith(
      COMPANY_ID, expect.objectContaining({ limit: 100, offset: 100 }),
    );
    expect(out.next_offset).toBe(200);
  });

  it('answers next_offset null on the last page', async () => {
    vi.mocked(listCustomerInvoices).mockResolvedValue({ invoices: rows(50), total: 250 });
    const out = body(await listInvoicesTool.handler({ limit: 100, offset: 200 }, ctx));

    expect(out.next_offset).toBeNull();
  });
});
