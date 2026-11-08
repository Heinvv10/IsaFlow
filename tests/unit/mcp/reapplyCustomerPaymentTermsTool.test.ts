/**
 * reapply_customer_payment_terms — the tool's own contract (service mocked). The skip decisions under lock are pinned in
 * the service's integration tests; this pins what only the tool decides: preview by default (and it frees the idempotency
 * key), the items mapping, the dry run's checks, and refusals. It is a separate tool from reapply_payment_terms.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The real ReapplyRefusal and parseReapplyItems (pure): the dry run must refuse exactly what the live call refuses.
vi.mock('@/modules/accounting/services/ar/reapplyTerms', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/ar/reapplyTerms')>('@/modules/accounting/services/ar/reapplyTerms');
  return { ...actual, previewReapplyCustomerTerms: vi.fn(), applyReapplyCustomerTerms: vi.fn() };
});

import { applyReapplyCustomerTerms, previewReapplyCustomerTerms } from '@/modules/accounting/services/ar/reapplyTerms';
import { ReapplyRefusal } from '@/modules/accounting/services/shared/reapplyTermsShared';
import { CustomerInvoiceLockTimeoutError } from '@/modules/accounting/services/ar/customerInvoiceLock';
import { reapplyCustomerPaymentTermsTool } from '@/lib/mcp/tools/writeReapplyCustomerPaymentTerms';
import { reapplyPaymentTermsTool } from '@/lib/mcp/tools/writeReapplyPaymentTerms';
import type { McpToolContext } from '@/lib/mcp/types';

const INV = 'b1b1b1b1-0000-4000-8000-000000000001';
const CUST = 'a1a1a1a1-0000-4000-8000-000000000002';
const INV2 = 'b2b2b2b2-0000-4000-8000-000000000003';
/** The preview row's current date and source, sent back with each confirmed item. */
const FROM = { current_due_date: '2026-10-31', current_source: 'terms' };
const ctx = { companyId: 'cccccccc-0000-4000-8000-cccccccccccc', userId: 'u-1' } as unknown as McpToolContext;
const run = (args: Record<string, unknown>) => reapplyCustomerPaymentTermsTool.handler({ idempotency_key: 'k-1', ...args }, ctx);
const body = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(previewReapplyCustomerTerms).mockResolvedValue({
    rows: [{
      id: INV, invoiceNumber: 'INV-1', customerId: CUST, customerName: 'Acme', status: 'approved',
      invoiceDate: '2026-10-01', balance: 100, currencyCode: 'USD', currentDueDate: '2026-10-31', currentSource: 'terms',
      newDueDate: '2026-11-15', terms: '45 days', preselected: false, note: 'Due date was set by hand',
    }],
    unchanged: 3, truncated: false,
    skippedCustomers: [{ customerId: CUST, customerName: 'NoTerms', openInvoices: 2, balance: 50 }],
  });
  vi.mocked(applyReapplyCustomerTerms).mockResolvedValue({
    updated: [{ id: INV, invoiceNumber: 'INV-1', from: '2026-10-31', to: '2026-11-15' }],
    skipped: [{ id: INV2, reason: 'terms_changed' }],
  });
});

describe('reapply_customer_payment_terms', () => {
  it('is its own tool: another name, and the supplier tool is untouched', () => {
    expect(reapplyCustomerPaymentTermsTool.name).toBe('reapply_customer_payment_terms');
    expect(reapplyCustomerPaymentTermsTool.write).toBe(true);
    expect(reapplyCustomerPaymentTermsTool.scope).toBe(reapplyPaymentTermsTool.scope);
    expect(reapplyPaymentTermsTool.name).toBe('reapply_payment_terms');
    expect(Object.keys(reapplyPaymentTermsTool.inputSchema.properties as object)).toEqual(['supplier_id', 'dry_run', 'items', 'idempotency_key']);
    expect(Object.keys(reapplyCustomerPaymentTermsTool.inputSchema.properties as object)).toEqual(['customer_id', 'dry_run', 'items', 'idempotency_key']);
  });

  it('previews on dry_run true in snake_case, never applies, and frees the idempotency key', async () => {
    const r = await run({ dry_run: true, customer_id: CUST });
    expect(r.wroteNothing).toBe(true); // else the registry stores the preview under the key the confirmed call reuses
    const out = body(r);
    expect(previewReapplyCustomerTerms).toHaveBeenCalledWith(ctx.companyId, { customerId: CUST });
    expect(applyReapplyCustomerTerms).not.toHaveBeenCalled();
    expect(out.rows[0]).toMatchObject({
      invoice_id: INV, customer_id: CUST, customer_name: 'Acme', currency_code: 'USD', new_due_date: '2026-11-15', preselected: false,
      note: 'Due date was set by hand',
    });
    expect(out).toMatchObject({ unchanged: 3, truncated: false });
    expect(out.skipped_customers[0]).toEqual({ customer_id: CUST, customer_name: 'NoTerms', open_invoices: 2, balance: 50 });
  });

  it('live without items is an error and calls nothing', async () => {
    for (const args of [{ dry_run: false }, { dry_run: false, items: [] }]) {
      const r = await run(args);
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('items is required');
    }
    expect(applyReapplyCustomerTerms).not.toHaveBeenCalled();
    expect(previewReapplyCustomerTerms).not.toHaveBeenCalled();
  });

  it('live maps items to {id, dueDate, fromDueDate, fromSource} and returns the skip reasons', async () => {
    const out = body(await run({ dry_run: false, items: [{ invoice_id: INV, due_date: '2026-11-15', ...FROM }] }));
    expect(applyReapplyCustomerTerms).toHaveBeenCalledWith(ctx.companyId, [{ id: INV, dueDate: '2026-11-15', fromDueDate: '2026-10-31', fromSource: 'terms' }]);
    expect(previewReapplyCustomerTerms).not.toHaveBeenCalled();
    expect(out.updated).toEqual([{ invoice_id: INV, invoice_number: 'INV-1', from: '2026-10-31', to: '2026-11-15' }]);
    expect(out.skipped).toEqual([{ invoice_id: INV2, reason: 'terms_changed' }]);
  });

  it('turns a ReapplyRefusal into a toolError', async () => {
    vi.mocked(applyReapplyCustomerTerms).mockRejectedValue(new ReapplyRefusal('items[0].id must be an invoice id'));
    const r = await run({ dry_run: false, items: [{ invoice_id: 'x', due_date: '2026-11-15', ...FROM }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('items[0].id must be an invoice id');
  });

  // Re-thrown, never returned: only a throw rolls the registry's savepoint back over the invoices already written.
  it('rethrows a lock timeout and anything else', async () => {
    vi.mocked(applyReapplyCustomerTerms).mockRejectedValue(new CustomerInvoiceLockTimeoutError('Invoice INV-1'));
    await expect(run({ dry_run: false, items: [{ invoice_id: INV, due_date: '2026-11-15', ...FROM }] })).rejects.toThrow('retry in a moment');
    vi.mocked(applyReapplyCustomerTerms).mockRejectedValue(new Error('connection reset'));
    await expect(run({ dry_run: false, items: [{ invoice_id: INV, due_date: '2026-11-15', ...FROM }] })).rejects.toThrow('connection reset');
  });

  it('a live call does not free the key', async () => {
    expect((await run({ dry_run: false, items: [{ invoice_id: INV, due_date: '2026-11-15', ...FROM }] })).wroteNothing).toBeUndefined();
  });

  it('refuses a call without dry_run and a malformed customer_id before the service', async () => {
    expect((await run({})).isError).toBe(true);
    expect((await run({ dry_run: true, customer_id: 'nope' })).isError).toBe(true);
    expect(previewReapplyCustomerTerms).not.toHaveBeenCalled();
  });

  // The pairs an agent will send can be dry-run, refused exactly as live refuses them (invoice wording included).
  it('a dry run checks the pairs it is given as the live call does, and says what each would do', async () => {
    const bad = await run({ dry_run: true, items: [{ invoice_id: 'nope', due_date: '2026-02-30' }] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain('must be an invoice id');
    const withItems = await run({ dry_run: true, items: [
      { invoice_id: INV, due_date: '2026-11-15', ...FROM }, { invoice_id: INV2, due_date: '2026-11-15', ...FROM },
    ] });
    expect(withItems.wroteNothing).toBe(true); // a dry run that carries items still frees the idempotency key
    const out = body(withItems);
    expect(out.items_check).toEqual([{ invoice_id: INV, would: 'update' }, { invoice_id: INV2, would: 'not_listed' }]);
    const stale = body(await run({ dry_run: true, items: [{ invoice_id: INV, due_date: '2026-12-01', ...FROM }] }));
    expect(stale.items_check).toEqual([{ invoice_id: INV, would: 'terms_changed' }]);
    const moved = body(await run({ dry_run: true, items: [{ invoice_id: INV, due_date: '2026-11-15', current_due_date: '2026-10-20', current_source: 'terms' }] }));
    expect(moved.items_check).toEqual([{ invoice_id: INV, would: 'date_changed' }]);
    const resourced = body(await run({ dry_run: true, items: [{ invoice_id: INV, due_date: '2026-11-15', current_due_date: '2026-10-31', current_source: 'manual' }] }));
    expect(resourced.items_check).toEqual([{ invoice_id: INV, would: 'date_changed' }]);
    expect((await run({ dry_run: true, items: [{ invoice_id: INV, due_date: '2026-11-15' }] })).isError).toBe(true);
    expect(applyReapplyCustomerTerms).not.toHaveBeenCalled();
  });
});
