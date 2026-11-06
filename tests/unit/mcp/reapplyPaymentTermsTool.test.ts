/**
 * reapply_payment_terms — the tool's own contract (service mocked). The skip decisions under lock are pinned in the
 * service's tests; this pins what only the tool decides: preview by default, the items mapping, and refusals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real ReapplyRefusal and parseReapplyItems (pure): the dry run must refuse exactly what the live call refuses.
vi.mock('@/modules/accounting/services/ap/reapplyTerms', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/ap/reapplyTerms')>('@/modules/accounting/services/ap/reapplyTerms');
  return { ...actual, previewReapplyTerms: vi.fn(), applyReapplyTerms: vi.fn() };
});

import { ReapplyRefusal, applyReapplyTerms, previewReapplyTerms } from '@/modules/accounting/services/ap/reapplyTerms';
import { SupplierInvoiceLockTimeoutError } from '@/modules/accounting/services/ap/supplierInvoiceLock';
import { reapplyPaymentTermsTool } from '@/lib/mcp/tools/writeReapplyPaymentTerms';
import type { McpToolContext } from '@/lib/mcp/types';

const BILL = 'b1b1b1b1-0000-4000-8000-000000000001';
const SUP = 'a1a1a1a1-0000-4000-8000-000000000002';
const BILL2 = 'b2b2b2b2-0000-4000-8000-000000000003';
/** The preview row's current date and source, sent back with each confirmed item. */
const FROM = { current_due_date: '2026-10-31', current_source: 'terms' };
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
    skipped: [{ id: BILL2, reason: 'terms_changed' }],
  });
});

describe('reapply_payment_terms', () => {
  it('previews on dry_run true in snake_case, never applies, and frees the idempotency key', async () => {
    const r = await run({ dry_run: true, supplier_id: SUP });
    expect(r.wroteNothing).toBe(true); // else the registry stores the preview under the key the confirmed call reuses
    const out = body(r);
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
    const out = body(await run({ dry_run: false, items: [{ invoice_id: BILL, due_date: '2026-11-15', ...FROM }] }));
    expect(applyReapplyTerms).toHaveBeenCalledWith(ctx.companyId, [{ id: BILL, dueDate: '2026-11-15', fromDueDate: '2026-10-31', fromSource: 'terms' }]);
    expect(previewReapplyTerms).not.toHaveBeenCalled();
    expect(out.updated).toEqual([{ invoice_id: BILL, invoice_number: 'INV-1', from: '2026-10-31', to: '2026-11-15' }]);
    expect(out.skipped).toEqual([{ invoice_id: BILL2, reason: 'terms_changed' }]);
  });

  it('turns a ReapplyRefusal into a toolError', async () => {
    vi.mocked(applyReapplyTerms).mockRejectedValue(new ReapplyRefusal('items[0].id must be a bill id'));
    const r = await run({ dry_run: false, items: [{ invoice_id: 'x', due_date: '2026-11-15', ...FROM }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('items[0].id must be a bill id');
  });

  // Re-thrown, never returned: only a throw rolls the registry's savepoint back over the bills already written.
  it('rethrows a lock timeout and anything else', async () => {
    vi.mocked(applyReapplyTerms).mockRejectedValue(new SupplierInvoiceLockTimeoutError(BILL));
    await expect(run({ dry_run: false, items: [{ invoice_id: BILL, due_date: '2026-11-15', ...FROM }] })).rejects.toThrow('retry in a moment');
    vi.mocked(applyReapplyTerms).mockRejectedValue(new Error('connection reset'));
    await expect(run({ dry_run: false, items: [{ invoice_id: BILL, due_date: '2026-11-15', ...FROM }] })).rejects.toThrow('connection reset');
  });

  it('a live call does not free the key', async () => {
    expect((await run({ dry_run: false, items: [{ invoice_id: BILL, due_date: '2026-11-15', ...FROM }] })).wroteNothing).toBeUndefined();
  });

  it('refuses a call without dry_run and a malformed supplier_id before the service', async () => {
    expect((await run({})).isError).toBe(true);
    expect((await run({ dry_run: true, supplier_id: 'nope' })).isError).toBe(true);
    expect(previewReapplyTerms).not.toHaveBeenCalled();
  });

  // Breaker REPRO 3: the pairs an agent will send can be dry-run, refused exactly as live refuses them.
  it('a dry run checks the pairs it is given as the live call does, and says what each would do', async () => {
    const bad = await run({ dry_run: true, items: [{ invoice_id: 'nope', due_date: '2026-02-30' }] });
    expect(bad.isError).toBe(true);
    const out = body(await run({ dry_run: true, items: [
      { invoice_id: BILL, due_date: '2026-11-15', ...FROM }, { invoice_id: BILL2, due_date: '2026-11-15', ...FROM },
    ] }));
    expect(out.items_check).toEqual([{ invoice_id: BILL, would: 'update' }, { invoice_id: BILL2, would: 'not_listed' }]);
    const stale = body(await run({ dry_run: true, items: [{ invoice_id: BILL, due_date: '2026-12-01', ...FROM }] }));
    expect(stale.items_check).toEqual([{ invoice_id: BILL, would: 'terms_changed' }]);
    // A row whose date or source moved since the preview the pairs came from (set by hand in between).
    const moved = body(await run({ dry_run: true, items: [{ invoice_id: BILL, due_date: '2026-11-15', current_due_date: '2026-10-20', current_source: 'terms' }] }));
    expect(moved.items_check).toEqual([{ invoice_id: BILL, would: 'date_changed' }]);
    const resourced = body(await run({ dry_run: true, items: [{ invoice_id: BILL, due_date: '2026-11-15', current_due_date: '2026-10-31', current_source: 'manual' }] }));
    expect(resourced.items_check).toEqual([{ invoice_id: BILL, would: 'date_changed' }]);
    // Leaving out the previewed date and source is refused, dry run and live alike.
    expect((await run({ dry_run: true, items: [{ invoice_id: BILL, due_date: '2026-11-15' }] })).isError).toBe(true);
    expect(applyReapplyTerms).not.toHaveBeenCalled();
  });
});
