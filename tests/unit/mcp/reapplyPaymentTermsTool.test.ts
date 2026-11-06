/**
 * reapply_payment_terms — the tool's own contract (service mocked). The skip decisions under lock are pinned in the
 * service's tests; this pins what only the tool decides: preview by default, the items mapping, and refusals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/ap/reapplyTerms', () => {
  class ReapplyRefusal extends Error {}
  return { REAPPLY_MAX: 2000, ReapplyRefusal, previewReapplyTerms: vi.fn(), applyReapplyTerms: vi.fn() };
});

import { ReapplyRefusal, applyReapplyTerms, previewReapplyTerms } from '@/modules/accounting/services/ap/reapplyTerms';
import { SupplierInvoiceLockTimeoutError } from '@/modules/accounting/services/ap/supplierInvoiceLock';
import { reapplyPaymentTermsTool } from '@/lib/mcp/tools/writeReapplyPaymentTerms';
import type { McpToolContext } from '@/lib/mcp/types';

const BILL = 'b1b1b1b1-0000-4000-8000-000000000001';
const SUP = 'a1a1a1a1-0000-4000-8000-000000000002';
const ctx = { companyId: 'cccccccc-0000-4000-8000-cccccccccccc', userId: 'u-1' } as unknown as McpToolContext;
const run = (args: Record<string, unknown>) => reapplyPaymentTermsTool.handler({ idempotency_key: 'k-1', ...args }, ctx);
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(previewReapplyTerms).mockResolvedValue({
    rows: [{
      id: BILL, invoiceNumber: 'INV-1', supplierId: SUP, supplierName: 'Acme', status: 'approved',
      invoiceDate: '2026-10-01', balance: 100, currentDueDate: '2026-10-31', currentSource: 'terms',
      newDueDate: '2026-11-15', terms: '45 days', preselected: false, note: 'Due date was set by hand',
    }],
    unchanged: 3, truncated: false,
    skippedSuppliers: [{ supplierId: SUP, supplierName: 'NoTerms', openBills: 2, balance: 50 }],
  });
  vi.mocked(applyReapplyTerms).mockResolvedValue({
    updated: [{ id: BILL, invoiceNumber: 'INV-1', from: '2026-10-31', to: '2026-11-15' }],
    skipped: [{ id: SUP, reason: 'terms_changed' }],
  });
});

describe('reapply_payment_terms', () => {
  it('previews on dry_run true in snake_case and never applies', async () => {
    const out = body(await run({ dry_run: true, supplier_id: SUP }));
    expect(previewReapplyTerms).toHaveBeenCalledWith(ctx.companyId, { supplierId: SUP });
    expect(applyReapplyTerms).not.toHaveBeenCalled();
    expect(out.rows[0]).toMatchObject({ invoice_id: BILL, new_due_date: '2026-11-15', preselected: false, note: 'Due date was set by hand' });
    expect(out).toMatchObject({ unchanged: 3, truncated: false });
    expect(out.skipped_suppliers[0]).toEqual({ supplier_id: SUP, supplier_name: 'NoTerms', open_bills: 2, balance: 50 });
  });

  it('live without items is an error and calls nothing', async () => {
    for (const args of [{ dry_run: false }, { dry_run: false, items: [] }]) {
      const r = await run(args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('items is required');
    }
    expect(applyReapplyTerms).not.toHaveBeenCalled();
    expect(previewReapplyTerms).not.toHaveBeenCalled();
  });

  it('live maps items to {id, dueDate} and returns the skip reasons', async () => {
    const out = body(await run({ dry_run: false, items: [{ invoice_id: BILL, due_date: '2026-11-15' }] }));
    expect(applyReapplyTerms).toHaveBeenCalledWith(ctx.companyId, [{ id: BILL, dueDate: '2026-11-15' }]);
    expect(previewReapplyTerms).not.toHaveBeenCalled();
    expect(out.updated).toEqual([{ invoice_id: BILL, invoice_number: 'INV-1', from: '2026-10-31', to: '2026-11-15' }]);
    expect(out.skipped).toEqual([{ invoice_id: SUP, reason: 'terms_changed' }]);
  });

  it('turns a ReapplyRefusal into a toolError', async () => {
    vi.mocked(applyReapplyTerms).mockRejectedValue(new ReapplyRefusal('items[0].id must be a bill id'));
    const r = await run({ dry_run: false, items: [{ invoice_id: 'x', due_date: '2026-11-15' }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('items[0].id must be a bill id');
  });

  it('turns a lock timeout into a retryable toolError and rethrows anything else', async () => {
    vi.mocked(applyReapplyTerms).mockRejectedValue(new SupplierInvoiceLockTimeoutError(BILL));
    const r = await run({ dry_run: false, items: [{ invoice_id: BILL, due_date: '2026-11-15' }] });
    expect(text(r)).toContain('retry in a moment');
    vi.mocked(applyReapplyTerms).mockRejectedValue(new Error('connection reset'));
    await expect(run({ dry_run: false, items: [{ invoice_id: BILL, due_date: '2026-11-15' }] })).rejects.toThrow('connection reset');
  });

  it('refuses a call without dry_run and a malformed supplier_id before the service', async () => {
    expect((await run({})).isError).toBe(true);
    expect((await run({ dry_run: true, supplier_id: 'nope' })).isError).toBe(true);
    expect(previewReapplyTerms).not.toHaveBeenCalled();
  });
});
