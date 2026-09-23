/**
 * update_supplier_invoice — the tool's own contract. The plan's refusals and
 * the written figures are pinned against a real database in
 * update-supplier-invoice.int.test.ts; this pins what only the tool decides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/ap/supplierInvoiceDraftUpdate', () => {
  class SupplierInvoiceDraftUpdateRefusal extends Error {}
  return {
    SupplierInvoiceDraftUpdateRefusal,
    lockAndPlanSupplierInvoiceDraftUpdate: vi.fn(),
    applySupplierInvoiceDraftUpdate: vi.fn(),
  };
});
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  getSupplierInvoiceById: vi.fn(),
}));

import {
  SupplierInvoiceDraftUpdateRefusal,
  applySupplierInvoiceDraftUpdate,
  lockAndPlanSupplierInvoiceDraftUpdate,
} from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdate';
import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { updateSupplierInvoiceTool } from '@/lib/mcp/tools/writeUpdateSupplierInvoice';
import type { McpToolContext } from '@/lib/mcp/types';

const BILL = 'b1b1b1b1-0000-4000-8000-000000000001';
const ctx = { companyId: 'cccccccc-0000-4000-8000-cccccccccccc', userId: 'u-1' } as unknown as McpToolContext;
const KEY = { idempotency_key: 'k-1' };
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const run = (args: Record<string, unknown>) =>
  updateSupplierInvoiceTool.handler({ invoice_id: BILL, ...args, ...KEY }, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(lockAndPlanSupplierInvoiceDraftUpdate).mockResolvedValue({ changed: ['reference'] } as never);
  vi.mocked(getSupplierInvoiceById).mockResolvedValue({ id: BILL, items: [] } as never);
});

describe('update_supplier_invoice', () => {
  it('refuses a malformed patch before any read', async () => {
    expect(text(await updateSupplierInvoiceTool.handler({ ...KEY }, ctx))).toBe('invoice_id is required');
    expect(text(await run({}))).toContain('Nothing to update');
    expect(text(await run({ invoice_number: 'x'.repeat(51) }))).toContain('maximum is 50');
    expect(text(await run({ lines: [{ description: 'a', quantity: 0, unit_price: 1 }] })))
      .toContain('lines[0].quantity');
    expect((await run({ due_date: 'soon' })).isError).toBe(true);
    expect(lockAndPlanSupplierInvoiceDraftUpdate).not.toHaveBeenCalled();
  });

  it('passes only the fields sent, mapped to the service names', async () => {
    await run({ reference: ' R-9 ', tax_rate: 0, lines: [{ description: 'a', quantity: 1, unit_price: 2 }] });
    expect(vi.mocked(lockAndPlanSupplierInvoiceDraftUpdate).mock.calls[0]![2]).toEqual({
      reference: 'R-9',
      taxRate: 0,
      items: [{ description: 'a', quantity: 1, unitPrice: 2, taxRate: undefined, glAccountId: undefined }],
    });
  });

  it('returns a plan refusal as a toolError and never writes', async () => {
    vi.mocked(lockAndPlanSupplierInvoiceDraftUpdate).mockRejectedValue(new SupplierInvoiceDraftUpdateRefusal('is approved'));
    expect(text(await run({ reference: 'x' }))).toBe('is approved');
    expect(applySupplierInvoiceDraftUpdate).not.toHaveBeenCalled();
  });

  it('rethrows anything that is not a refusal, so the registry rolls back', async () => {
    vi.mocked(lockAndPlanSupplierInvoiceDraftUpdate).mockRejectedValue(new Error('connection reset'));
    await expect(run({ reference: 'x' })).rejects.toThrow('connection reset');
    vi.mocked(lockAndPlanSupplierInvoiceDraftUpdate).mockResolvedValue({ changed: [] } as never);
    vi.mocked(applySupplierInvoiceDraftUpdate).mockRejectedValue(new Error('deadlock'));
    await expect(run({ reference: 'x' })).rejects.toThrow('deadlock');
  });
});
