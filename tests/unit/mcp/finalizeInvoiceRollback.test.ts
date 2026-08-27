/**
 * finalize_invoice must let a GL posting failure reach the registry.
 *
 * The MCP transport answers HTTP 200 for every tool result, `isError: true`
 * included (pages/api/mcp/index.ts), and bearerPipeline decides commit-vs-
 * rollback from `res.statusCode >= 500`. So a 200 tool error COMMITs.
 *
 * The registry compensates: write tools run inside `withSavepoint(mcp_<name>)`,
 * which rolls back when the handler THROWS. That protection is only reachable
 * if the tool actually throws. finalize_invoice used to catch everything and
 * return `toolError(safeErrorText(...))` — the handler returned normally, the
 * savepoint was RELEASEd, and the `UPDATE customer_invoices SET
 * status='approved'` that approveCustomerInvoice runs BEFORE posting the
 * journal was committed. Result: an invoice approved and sitting in AR with no
 * GL journal — the precise AR/GL divergence approveCustomerInvoice now throws
 * to prevent, reintroduced one layer up.
 *
 * The pre-write guard (InvoiceNotApprovableError, raised when the guarded
 * UPDATE matched zero rows) stays a clean tool error: nothing was written, so
 * there is nothing to roll back and the agent gets an actionable message.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() });
  return {
    sql: sqlFn,
    fmtDate: vi.fn(() => '2026-08-13'),
    withSavepoint: vi.fn((_n: string, cb: () => unknown) => cb()),
    withTransaction: vi.fn((cb: (tx: typeof sqlFn) => unknown) => cb(sqlFn)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', () => ({
  createDraftCustomerInvoice: vi.fn(),
  InvoiceLineValidationError: class InvoiceLineValidationError extends Error {},
}));
// The class is declared INSIDE the factory: vi.mock is hoisted above every
// top-level binding, so referencing an outer class here throws
// "Cannot access '<name>' before initialization".
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', () => ({
  approveCustomerInvoice: vi.fn(),
  InvoiceNotApprovableError: class InvoiceNotApprovableError extends Error {
    readonly notFound: boolean;
    constructor(message: string, notFound = false) {
      super(message);
      this.name = 'InvoiceNotApprovableError';
      this.notFound = notFound;
    }
  },
}));
vi.mock('@/modules/accounting/services/ar/quoteService', () => ({ createQuote: vi.fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customerBelongsToCompany: vi.fn().mockResolvedValue(true),
}));

import {
  approveCustomerInvoice,
  InvoiceNotApprovableError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { finalizeInvoiceTool } from '@/lib/mcp/tools/writeInvoices';

const COMPANY_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

const approveMock = approveCustomerInvoice as unknown as MockedFunction<
  (...a: unknown[]) => Promise<unknown>
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = () => ({ companyId: COMPANY_ID, userId: USER_ID, scopes: ['write:invoices', 'write:post'] }) as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('finalize_invoice — transaction boundary', () => {
  it('is registered as a write tool, so the registry wraps it in a SAVEPOINT', () => {
    // The rollback depends entirely on this flag: registry.ts only applies
    // withSavepoint when tool.write is true.
    expect(finalizeInvoiceTool.write).toBe(true);
  });

  it('RETHROWS a GL posting failure so the savepoint rolls the approval back', async () => {
    approveMock.mockRejectedValue(new Error('Cannot post to closed fiscal period'));

    // Must reject — NOT resolve to an isError envelope. A returned envelope
    // means the handler completed normally and the savepoint released.
    await expect(
      finalizeInvoiceTool.handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f' }, ctx()),
    ).rejects.toThrow(/closed fiscal period/);
  });

  it('rethrows an unexpected failure rather than reporting success-shaped failure', async () => {
    approveMock.mockRejectedValue(new Error('connection terminated'));

    await expect(
      finalizeInvoiceTool.handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f' }, ctx()),
    ).rejects.toThrow(/connection terminated/);
  });

  it('still returns a clean tool error for the pre-write status guard', async () => {
    approveMock.mockRejectedValue(new InvoiceNotApprovableError("Cannot approve an invoice with status 'cancelled'"));

    const result = await finalizeInvoiceTool.handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f' }, ctx());

    // Nothing was written (the guarded UPDATE matched zero rows), so there is
    // no partial state to discard and the agent gets the real reason.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/cancelled/);
  });

  it('still returns a tool error, not a throw, when the invoice_id is missing', async () => {
    const result = await finalizeInvoiceTool.handler({}, ctx());

    expect(result.isError).toBe(true);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('returns the approval result on the happy path', async () => {
    approveMock.mockResolvedValue({
      id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', status: 'approved', glJournalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', evidenceDocumentId: 'doc-1',
    });

    const result = await finalizeInvoiceTool.handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f' }, ctx());

    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toMatch(/97120700-9f09-4fe5-804e-34331ce49b97/);
  });
});
