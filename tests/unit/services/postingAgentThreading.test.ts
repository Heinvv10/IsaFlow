/**
 * Posting-agent threading on the invoice-approval path.
 *
 * finalize_invoice (MCP) posts a real AR journal via approveCustomerInvoice →
 * postCustomerInvoiceToGL → createJournalEntry. With no meta, createJournalEntry
 * falls back to defaultHumanMeta(userId) and the entry lands as
 * `human:<userId>` — agent work labelled as the token owner's own, and
 * invisible to list_agent_postings (which filters posting_agent LIKE 'mcp:%').
 *
 * The opts param is optional and last-positional precisely so every EXISTING
 * caller (the HTTP approve route, the Sage migration commit, the GL backfill
 * route) keeps its human attribution unchanged. Both halves are pinned here:
 * the override works, and the default did not move.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
    unsafe: vi.fn((s: string) => s),
  });
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) => String(d),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn().mockResolvedValue({ id: 'je-1' }),
  postJournalEntry: vi.fn(),
  reverseJournalEntry: vi.fn(),
}));

vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  resolveUserUuid: vi.fn(async (u: string) => u),
}));

vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ id: 'acct-1' }),
}));

// customerPaymentService (the barrel approveCustomerInvoice imports through) is
// deliberately NOT mocked: the point is to exercise the real threading from
// approve → postCustomerInvoiceToGL → createJournalEntry. Mocking the barrel
// with a factory that re-imports customerPaymentAllocationService deadlocks —
// the two modules import each other.
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn().mockResolvedValue({ documentId: 'doc-1', wasExisting: false }),
}));

import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockCreate = createJournalEntry as unknown as MockedFunction<
  (c: string, input: unknown, u: string, meta?: { postingAgent: string }) => Promise<{ id: string }>
>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const INVOICE_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const USER_ID = 'ffffffff-0000-4000-8000-ffffffffffff';

const INVOICE_ROW = {
  id: INVOICE_ID,
  invoice_number: 'INV-0001',
  invoice_date: '2026-08-04',
  status: 'approved',
  gl_journal_entry_id: null,
  total_amount: 115,
  subtotal: 100,
  tax_amount: 15,
};

/** First query loads the invoice; the rest are link-back UPDATEs. */
function armInvoiceLookup(): void {
  mockSql.mockReset();
  mockSql.mockResolvedValueOnce([INVOICE_ROW]).mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ id: 'je-1' });
});

describe('postCustomerInvoiceToGL posting agent', () => {
  it('defaults to human:<userId> when no opts are passed — existing callers unchanged', async () => {
    armInvoiceLookup();

    await postCustomerInvoiceToGL(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockCreate.mock.calls[0]![3]).toEqual({ postingAgent: `human:${USER_ID}` });
  });

  it('stamps the caller-supplied agent instead when one is given', async () => {
    armInvoiceLookup();

    await postCustomerInvoiceToGL(COMPANY_ID, INVOICE_ID, USER_ID, {
      postingAgent: 'mcp:finalize_invoice:v1',
    });

    expect(mockCreate.mock.calls[0]![3]).toEqual({ postingAgent: 'mcp:finalize_invoice:v1' });
  });

  it('falls back to human when opts is present but carries no agent', async () => {
    armInvoiceLookup();

    await postCustomerInvoiceToGL(COMPANY_ID, INVOICE_ID, USER_ID, {});

    expect(mockCreate.mock.calls[0]![3]).toEqual({ postingAgent: `human:${USER_ID}` });
  });
});

describe('approveCustomerInvoice threads the stamp to the GL journal', () => {
  /** approve UPDATE returns a row, then the invoice lookup, then UPDATEs. */
  function armApprove(): void {
    mockSql.mockReset();
    mockSql
      .mockResolvedValueOnce([{ id: INVOICE_ID }])   // status transition
      .mockResolvedValueOnce([INVOICE_ROW])          // invoice load inside postCustomerInvoiceToGL
      .mockResolvedValue([]);
  }

  it('passes an MCP stamp straight through to createJournalEntry', async () => {
    armApprove();

    await approveCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID, {
      postingAgent: 'mcp:finalize_invoice:v1',
    });

    expect(mockCreate.mock.calls[0]![3]).toEqual({ postingAgent: 'mcp:finalize_invoice:v1' });
  });

  it('keeps human attribution for the HTTP approve route, which passes no opts', async () => {
    armApprove();

    await approveCustomerInvoice(COMPANY_ID, INVOICE_ID, USER_ID);

    expect(mockCreate.mock.calls[0]![3]).toEqual({ postingAgent: `human:${USER_ID}` });
  });
});
