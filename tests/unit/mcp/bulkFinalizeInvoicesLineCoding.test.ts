/**
 * Migration 870: an invoice whose stored line coding approve would refuse (an
 * account deactivated since, a foreign id) is a SKIP in bulk_finalize_invoices
 * with approve's own reason — in the dry run and the live call alike, so the
 * preview is of the batch that posts. The refusal itself is pinned against a
 * real chart by tests/integration/invoice-line-revenue-posting.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/mcp/tools/bulkApprovePeriods', () => ({ resolvePeriodSkips: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ agentApprovalRefusals: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ validateSystemAccounts: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/ar/invoiceLineCodingGuard', () => ({
  storedInvoiceLinesRefusals: vi.fn(async () => new Map<string, string>()),
}));
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', () => ({
  approvableCustomerInvoiceIds: vi.fn(async (_c: string, ids: string[]) => ids),
  approveCustomerInvoice: vi.fn(),
  InvoiceNotApprovableError: class extends Error {
    notFound: boolean;
    constructor(message: string, notFound = false) { super(message); this.notFound = notFound; }
  },
}));

import { sql } from '@/lib/neon';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { storedInvoiceLinesRefusals } from '@/modules/accounting/services/ar/invoiceLineCodingGuard';
import { bulkFinalizeInvoicesTool } from '@/lib/mcp/tools/writeBulkFinalizeInvoices';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const ID = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REASON = 'Invoice INV-2: An invoice line cannot be coded to 4100 Commercials: it is inactive. Recode the line on the draft, or cancel the invoice and re-enter it.';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(approveCustomerInvoice).mockImplementation((async (_c: string, id: string) => ({
    id, status: 'approved', glJournalEntryId: `je-${id.slice(-2)}`, evidenceDocumentId: null,
  })) as never);
});

describe('bulk_finalize_invoices — line coding approve would refuse', () => {
  it('is skipped with approve\'s reason in the dry run and the live call alike', async () => {
    for (const dry of [true, false]) {
      vi.mocked(sql).mockResolvedValue([
        { id: ID(1), status: 'draft', invoice_date: '2026-07-15', invoice_number: 'INV-1', total_amount: 115 },
        { id: ID(2), status: 'draft', invoice_date: '2026-07-15', invoice_number: 'INV-2', total_amount: 115 },
      ] as never);
      vi.mocked(storedInvoiceLinesRefusals).mockResolvedValueOnce(new Map([[ID(2), REASON]]));
      const res = await bulkFinalizeInvoicesTool.handler(
        { invoice_ids: [ID(1), ID(2)], idempotency_key: 'k', ...(dry ? { dry_run: true } : {}) }, ctx,
      ) as { content: { text: string }[] };
      const out = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
      expect(out.skipped).toEqual([{ index: 1, document_id: ID(2), reason: REASON }]);
      expect(dry ? out.would_post_ids : (out.invoices as { id: string }[]).map((i) => i.id)).toEqual([ID(1)]);
    }
    expect(vi.mocked(approveCustomerInvoice).mock.calls.map((c) => c[1])).toEqual([ID(1)]);
    expect(vi.mocked(storedInvoiceLinesRefusals).mock.calls[0]).toEqual(['company-1', [ID(1), ID(2)]]);
  });
});
