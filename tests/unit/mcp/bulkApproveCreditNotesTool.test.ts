/**
 * Handler-level contract for `bulk_approve_credit_notes` — split out of
 * `bulkApproveTools.test.ts` by concern (K-072 r37), with the same mocks, so both
 * files stay under the 300-line cap. The assertions are unchanged.
 *
 * The properties here are the ones that decide whether an agent can trust what
 * it is told: that `dry_run` previews the SAME batch the live call posts, that
 * a call which wrote nothing does not burn its idempotency key, and that a
 * batch where everything skipped REFUSES rather than reporting a success with
 * nothing in it.
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
// The allocation rows are read back from the database by the tool. Mocked so
// the assertions describe the TOOL's reporting, not the shared `sql` fixture
// that readStates also uses.
vi.mock('@/modules/accounting/services/shared/creditNoteFifo', async () => {
  const actual = await vi.importActual<typeof import('@/modules/accounting/services/shared/creditNoteFifo')>(
    '@/modules/accounting/services/shared/creditNoteFifo',
  );
  return { ...actual, listCreditNoteAllocations: vi.fn().mockResolvedValue([]) };
});
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  approveCreditNote: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { resolvePeriodSkips } from '@/lib/mcp/tools/bulkApprovePeriods';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { listCreditNoteAllocations } from '@/modules/accounting/services/shared/creditNoteFifo';
import { bulkApproveCreditNotesTool } from '@/lib/mcp/tools/writeBulkApproveCreditNotes';

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
  // clearAllMocks wipes the factory's default, so it is re-primed here.
  vi.mocked(listCreditNoteAllocations).mockResolvedValue([]);
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

describe('bulk_approve_credit_notes', () => {
  it('only drafts are approvable', async () => {
    rows({ id: ID(1), status: 'approved', credit_date: '2026-09-01',
           credit_note_number: 'CN-1', type: 'customer' });
    const res = await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('status is approved');
  });

  /**
   * The roles depend on which note TYPES the batch contains. Refusing a batch
   * of customer notes because the chart lacks `vat_input` — which nothing in it
   * would touch — is the mistake the per-type union avoids.
   */
  it('does not refuse a customer-note batch for a missing SUPPLIER role', async () => {
    vi.mocked(validateSystemAccounts).mockResolvedValue(['vat_input', 'payable'] as never);
    rows({ id: ID(1), status: 'draft', credit_date: '2026-09-01',
           credit_note_number: 'CN-1', type: 'customer' });
    const res = await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result;
    expect(res.isError).toBeUndefined();
    expect(approveCreditNote).toHaveBeenCalledTimes(1);
  });

  it('DOES refuse when the type present is the one missing a role', async () => {
    vi.mocked(validateSystemAccounts).mockResolvedValue(['vat_input'] as never);
    rows({ id: ID(1), status: 'draft', credit_date: '2026-09-01',
           credit_note_number: 'CN-1', type: 'supplier' });
    const res = await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('vat_input');
    expect(approveCreditNote).not.toHaveBeenCalled();
  });

  /**
   * An 'applied' note reduced an invoice's outstanding balance. An agent
   * reading 'approved' vs 'applied' as cosmetic would look for a second apply
   * step and double-credit the invoice, so the link is reported explicitly.
   */
  it('names EVERY document the note settled, not just the linked one', async () => {
    vi.mocked(approveCreditNote).mockResolvedValue({
      id: ID(1), creditNoteNumber: 'CN-1', type: 'customer', status: 'applied',
      totalAmount: 57.5, appliedAmount: 57.5, glJournalEntryId: 'je-1', customerInvoiceId: ID(9),
    } as never);
    // The FIFO walk settled two bills; a single `applied_to_invoice_id` could
    // only ever have named one of them.
    vi.mocked(listCreditNoteAllocations).mockResolvedValue([
      { invoiceId: ID(9), amount: 40 },
      { invoiceId: ID(8), amount: 17.5 },
    ]);
    rows({ id: ID(1), status: 'draft', credit_date: '2026-09-01',
           credit_note_number: 'CN-1', type: 'customer' });
    const res = payload(await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result);
    const row = (res.credit_notes as Array<Record<string, unknown>>)[0]!;
    expect(row.applied_to_invoice_ids).toEqual([
      { invoice_id: ID(9), amount: 40 },
      { invoice_id: ID(8), amount: 17.5 },
    ]);
    expect(row.applied_amount).toBe(57.5);
    expect(res.applied_count).toBe(1);
  });

  it('passes auto_apply through to the service and refuses an unknown value', async () => {
    rows({ id: ID(1), status: 'draft', credit_date: '2026-09-01',
           credit_note_number: 'CN-1', type: 'customer' });
    await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(1)], auto_apply: 'none', idempotency_key: 'k' }, ctx,
    );
    expect(vi.mocked(approveCreditNote).mock.calls[0]![3])
      .toMatchObject({ autoApply: 'none' });

    const bad = await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(1)], auto_apply: 'off', idempotency_key: 'k' }, ctx,
    ) as Result;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain('auto_apply must be one of');
  });

  /**
   * Adversarial review, 2026-09-08. approveCreditNote takes TWO row locks — the
   * note, then the linked invoice whose amount_paid it updates. Sorting by note
   * id alone leaves the INVOICE lock order to chance, so two batches sharing an
   * invoice can hold and wait crosswise and deadlock. Ordering by the linked
   * invoice first is what gives a total order over the contended rows.
   */
  it('posts in LINKED-INVOICE order, not note-id order', async () => {
    const INV_EARLY = '0b000000-0000-4000-8000-000000000001';
    const INV_LATE = '0b000000-0000-4000-8000-000000000002';
    // Note ID(1) sorts first by note id, but its invoice sorts LAST.
    rows(
      { id: ID(1), status: 'draft', credit_date: '2026-09-01',
        credit_note_number: 'CN-1', type: 'customer', linked_invoice_id: INV_LATE },
      { id: ID(2), status: 'draft', credit_date: '2026-09-01',
        credit_note_number: 'CN-2', type: 'customer', linked_invoice_id: INV_EARLY },
    );
    await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(1), ID(2)], idempotency_key: 'k' }, ctx,
    );
    expect(vi.mocked(approveCreditNote).mock.calls.map((c) => c[1]))
      .toEqual([ID(2), ID(1)]);
  });

  /** Standalone notes take no second lock, so they order among themselves by id. */
  it('orders standalone notes by note id', async () => {
    rows(
      { id: ID(3), status: 'draft', credit_date: '2026-09-01',
        credit_note_number: 'CN-3', type: 'customer', linked_invoice_id: null },
      { id: ID(1), status: 'draft', credit_date: '2026-09-01',
        credit_note_number: 'CN-1', type: 'customer', linked_invoice_id: null },
    );
    await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(3), ID(1)], idempotency_key: 'k' }, ctx,
    );
    expect(vi.mocked(approveCreditNote).mock.calls.map((c) => c[1]))
      .toEqual([ID(1), ID(3)]);
  });

  it('reports no applied documents for a note that merely approved', async () => {
    rows({ id: ID(1), status: 'draft', credit_date: '2026-09-01',
           credit_note_number: 'CN-1', type: 'customer' });
    const res = payload(await bulkApproveCreditNotesTool.handler(
      { credit_note_ids: [ID(1)], idempotency_key: 'k' }, ctx,
    ) as Result);
    expect((res.credit_notes as Array<Record<string, unknown>>)[0]!
      .applied_to_invoice_ids).toEqual([]);
    expect(res.applied_count).toBeUndefined();
  });
});
