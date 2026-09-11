/**
 * Handler-level contract for the three bulk approve tools.
 *
 * The properties here are the ones that decide whether an agent can trust what
 * it is told: that `dry_run` previews the SAME batch the live call posts, that
 * a call which wrote nothing does not burn its idempotency key, and that a
 * batch where everything skipped REFUSES rather than reporting a success with
 * nothing in it. `bulk_approve_credit_notes` is in `bulkApproveCreditNotesTool.test.ts`
 * (split out by concern, K-072 r37, to keep both files under the 300-line cap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/mcp/tools/bulkApprovePeriods', () => ({
  resolvePeriodSkips: vi.fn(async () => new Map()),
}));
vi.mock('@/modules/accounting/services/capture/capturedVatEvidence', () => ({
  invoiceVatRefusals: vi.fn(async () => new Map<string, string>()),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  validateSystemAccounts: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({
  approveSupplierInvoice: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', () => ({
  approveCustomerInvoice: vi.fn(),
  InvoiceNotApprovableError: class extends Error {
    notFound: boolean;
    constructor(message: string, notFound = false) { super(message); this.notFound = notFound; }
  },
}));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  approveCreditNote: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { resolvePeriodSkips } from '@/lib/mcp/tools/bulkApprovePeriods';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { invoiceVatRefusals } from '@/modules/accounting/services/capture/capturedVatEvidence';
import {
  bulkApproveSupplierInvoicesTool,
} from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import { bulkFinalizeInvoicesTool } from '@/lib/mcp/tools/writeBulkFinalizeInvoices';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const ID = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Result { content: { text: string }[]; isError?: boolean;
  wroteNothing?: boolean; billable?: boolean }

function payload(res: Result): Record<string, unknown> {
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

/** The rows the tools' own readStates query returns. */
function rows(...r: Record<string, unknown>[]): void {
  vi.mocked(sql).mockResolvedValue(r as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePeriodSkips).mockResolvedValue(new Map());
  vi.mocked(validateSystemAccounts).mockResolvedValue([]);
  vi.mocked(approveSupplierInvoice).mockImplementation((async (_c: string, id: string) => ({
    id, invoiceNumber: `INV-${id.slice(-2)}`, status: 'approved',
    totalAmount: 115, glJournalEntryId: `je-${id.slice(-2)}`,
  })) as never);
  vi.mocked(approveCreditNote).mockImplementation((async (_c: string, id: string) => ({
    id, creditNoteNumber: `CN-${id.slice(-2)}`, type: 'customer', status: 'approved',
    totalAmount: 57.5, glJournalEntryId: `je-${id.slice(-2)}`,
  })) as never);
});

describe('bulk_approve_supplier_invoices', () => {
  it('is a posting tool — write plus requiresPost', () => {
    expect(bulkApproveSupplierInvoicesTool.write).toBe(true);
    expect(bulkApproveSupplierInvoicesTool.requiresPost).toBe(true);
  });

  /**
   * A preview computed by different logic than the write is a preview of a
   * different batch. The bank pilot proved how that reads: dry_run reported an
   * already-allocated row as postable and only the live call discovered it.
   */
  it('dry_run previews exactly what the live call posts', async () => {
    const call = (dry: boolean) => bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(1), ID(2)], idempotency_key: 'k', ...(dry ? { dry_run: true } : {}) },
      ctx,
    ) as Promise<Result>;
    rows({ id: ID(1), status: 'draft', invoice_date: '2026-09-01' },
         { id: ID(2), status: 'cancelled', invoice_date: '2026-09-01' });
    const preview = payload(await call(true));
    rows({ id: ID(1), status: 'draft', invoice_date: '2026-09-01' },
         { id: ID(2), status: 'cancelled', invoice_date: '2026-09-01' });
    const live = payload(await call(false));

    expect(preview.would_post).toBe(1);
    expect(preview.would_post_ids).toEqual([ID(1)]);
    expect(live.posted).toBe(1);
    expect((live.invoices as { id: string }[]).map((i) => i.id)).toEqual([ID(1)]);
    expect(preview.skipped).toEqual(live.skipped);
  });

  it('K-072 r30–r32: a bill whose VAT its captured document does not show is SKIPPED, in the dry run and the live call alike', async () => {
    const call = (dry: boolean) => bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(1), ID(2)], idempotency_key: 'k', ...(dry ? { dry_run: true } : {}) }, ctx,
    ) as Promise<Result>;
    for (const dry of [true, false]) {
      rows({ id: ID(1), status: 'draft', invoice_date: '2026-09-01' }, { id: ID(2), status: 'draft', invoice_date: '2026-09-01' });
      vi.mocked(invoiceVatRefusals).mockResolvedValueOnce(new Map([[ID(2), 'its VAT is not evidenced by its captured document']]));
      const out = payload(await call(dry));
      expect(out.skipped).toEqual([{ index: 1, document_id: ID(2), reason: 'its VAT is not evidenced by its captured document' }]);
      expect(dry ? out.would_post_ids : (out.invoices as { id: string }[]).map((i) => i.id)).toEqual([ID(1)]);
    }
    expect(vi.mocked(approveSupplierInvoice).mock.calls.map((c) => c[1])).toEqual([ID(1)]);
  });

  it('dry_run posts nothing at all', async () => {
    rows({ id: ID(1), status: 'draft', invoice_date: '2026-09-01' });
    await bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(1)], idempotency_key: 'k', dry_run: true }, ctx,
    );
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  /**
   * A dry run stored under the key would be replayed to the real call forever —
   * same intent, same natural key — so the agent could never actually post.
   */
  it('dry_run frees the idempotency key and is not billed', async () => {
    rows({ id: ID(1), status: 'draft', invoice_date: '2026-09-01' });
    const res = await bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(1)], idempotency_key: 'k', dry_run: true }, ctx,
    ) as Result;
    expect(res.wroteNothing).toBe(true);
    expect(res.billable).toBe(false);
  });

  /**
   * Not `posted: 0`. An agent reading a success with nothing posted believes
   * the work was done — and a wholly wrong list would read as a silent success.
   */
  it('REFUSES a batch where every element skipped', async () => {
    rows({ id: ID(1), status: 'cancelled', invoice_date: '2026-09-01' });
    const res = await bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Nothing was posted');
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  /**
   * Each element takes a row lock held to the end of the request, so two
   * batches overlapping in opposite orders would deadlock (40P01). A total
   * order over the locked rows makes that impossible.
   */
  it('posts in id order, not the order the agent sent', async () => {
    rows({ id: ID(3), status: 'draft', invoice_date: '2026-09-01' },
         { id: ID(1), status: 'draft', invoice_date: '2026-09-01' });
    await bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(3), ID(1)], idempotency_key: 'k' }, ctx,
    );
    expect(vi.mocked(approveSupplierInvoice).mock.calls.map((c) => c[1]))
      .toEqual([ID(1), ID(3)]);
  });

  /** …but reports them back in the agent's own order, carrying its indexes. */
  it('reports results in the agent\'s order with its own indexes', async () => {
    rows({ id: ID(3), status: 'draft', invoice_date: '2026-09-01' },
         { id: ID(1), status: 'draft', invoice_date: '2026-09-01' });
    const res = payload(await bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(3), ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result);
    expect((res.invoices as { index: number; id: string }[]))
      .toEqual([
        expect.objectContaining({ index: 0, id: ID(3) }),
        expect.objectContaining({ index: 1, id: ID(1) }),
      ]);
  });

  /**
   * A chart missing a role fails EVERY element, so it is one refusal about the
   * request's preconditions — and it names the subtypes. Left to throw it would
   * reach the agent as a batch failure inviting a retry that cannot succeed,
   * the chart being identical on the second call.
   */
  it('refuses pre-write when the chart lacks a required system account', async () => {
    vi.mocked(validateSystemAccounts).mockResolvedValue(['vat_input'] as never);
    const res = await bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('vat_input');
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it('ignores a missing role the batch would never use', async () => {
    vi.mocked(validateSystemAccounts).mockResolvedValue(['vat_output'] as never);
    rows({ id: ID(1), status: 'draft', invoice_date: '2026-09-01' });
    const res = await bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result;
    expect(res.isError).toBeUndefined();
  });
});

describe('bulk_finalize_invoices', () => {
  it('is a posting tool and caps at 100', () => {
    expect(bulkFinalizeInvoicesTool.requiresPost).toBe(true);
    const schema = bulkFinalizeInvoicesTool.inputSchema as
      { properties: { invoice_ids: { maxItems: number } } };
    expect(schema.properties.invoice_ids.maxItems).toBe(100);
  });

  it('needs the AR roles, not the AP ones', async () => {
    vi.mocked(validateSystemAccounts).mockResolvedValue(['vat_output'] as never);
    const res = await bulkFinalizeInvoicesTool.handler(
      { invoice_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('vat_output');
  });
});
