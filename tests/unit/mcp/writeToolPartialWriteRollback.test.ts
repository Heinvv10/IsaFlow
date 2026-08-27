/**
 * MCP write tools must let a mid-write failure reach the registry.
 *
 * registry.ts wraps every `write: true` tool in `withSavepoint`, which rolls
 * back — but ONLY if the handler throws. A `catch → toolError` returns
 * normally, so the savepoint RELEASES, and because the MCP transport answers
 * HTTP 200 for every tool result (isError included) bearerPipeline COMMITs.
 * Whatever the service had already written is then permanent.
 *
 * That matters for these three specifically, because none of their services is
 * internally atomic across the whole operation:
 *
 *   create_draft_invoice   savepoint covers only the invoice-number retry; the
 *                          line items INSERT outside it → a committed invoice
 *                          header carrying a total with no detail.
 *   create_draft_quote     header INSERT then a line loop, no transaction and
 *                          no savepoint at all → header with partial lines.
 * import_bank_statement is DIFFERENT and is included only for the narrowing:
 * importParsedTransactions already wraps its writes in withTransaction, so
 * there is no partial-import exposure — and because withTransaction uses a
 * separate pooled connection, the registry's savepoint could not undo one in
 * any case. Its rethrow exists so a DB failure is recorded as a failed call
 * rather than a tidy tool error.
 *
 * finalize_invoice was fixed earlier and is covered by
 * finalizeInvoiceRollback.test.ts. The remaining write tools are safe because
 * their services ARE atomic (createJournalEntry batches header+lines in one
 * sql.transaction; postJournalEntry is a single UPDATE; bankAllocationService
 * uses transactions), so a swallowed throw leaves nothing behind.
 *
 * Each tool keeps reporting its PRE-write validation error precisely — those
 * are raised before the first INSERT, so there is nothing to roll back and the
 * agent gets an actionable message instead of a generic failure.
 */
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

const { createInvoiceMock, createQuoteMock, importMock, belongsMock, undoMock } = vi.hoisted(() => ({
  createInvoiceMock: vi.fn(),
  createQuoteMock: vi.fn(),
  importMock: vi.fn(),
  belongsMock: vi.fn(),
  undoMock: vi.fn(),
}));

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn().mockResolvedValue([]), { transaction: vi.fn() }),
  withTransaction: vi.fn(),
  withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
  fmtDate: (d: unknown) => String(d),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn().mockResolvedValue(true) }));

// Real error classes throughout — the tools narrow with `instanceof`, so a
// locally re-declared class would make every assertion self-consistent and
// prove nothing about production.
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/customerInvoiceCreateService')>()),
  createDraftCustomerInvoice: createInvoiceMock,
}));
vi.mock('@/modules/accounting/services/ar/quoteService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/ar/quoteService')>()),
  createQuote: createQuoteMock,
}));
vi.mock('@/modules/accounting/services/bank/bankStatementImportService', async (orig) => ({
  ...(await orig<typeof import('@/modules/accounting/services/bank/bankStatementImportService')>()),
  importStatementForAgent: importMock,
  undoImportBatch: undoMock,
  // The import tool checks bank-account ownership (exported from THIS module)
  // before it reaches the service. Left real, it queries the mocked sql, gets
  // no rows, and short-circuits to NOT_FOUND — so the rollback assertions
  // would never reach the catch they are meant to exercise.
  bankGlAccountBelongsToCompany: belongsMock,
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customerBelongsToCompany: belongsMock,
  supplierBelongsToCompany: vi.fn(),
  customersBelongToCompany: vi.fn().mockResolvedValue(true),
  suppliersBelongToCompany: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  getBankTransactionStatus: vi.fn(),
}));

import { InvoiceLineValidationError } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { LineValidationError } from '@/modules/accounting/services/ar/quoteService';
import { StatementNotImportableError } from '@/modules/accounting/services/bank/bankStatementImportErrors';
import { createDraftInvoiceTool, createDraftQuoteTool } from '@/lib/mcp/tools/writeInvoices';
import { importBankStatementTool } from '@/lib/mcp/tools/writeBankImport';

const COMPANY = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CUSTOMER = '33333333-3333-3333-3333-333333333333';
const BANK = '44444444-4444-4444-4444-444444444444';
const TX = '55555555-5555-5555-5555-555555555555';
const ACC = '66666666-6666-6666-6666-666666666666';
const BATCH = '77777777-7777-7777-7777-777777777777';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = () => ({ companyId: COMPANY, userId: USER, scopes: ['write:invoices', 'write:bank-tx'] }) as any;

const invoiceArgs = {
  customer_id: CUSTOMER,
  items: [{ description: 'Consulting', unit_price: 1000, quantity: 1 }],
  idempotency_key: 'k1',
};
const quoteArgs = {
  customer_name: 'Acme',
  items: [{ description: 'Consulting', unit_price: 1000, quantity: 1 }],
  idempotency_key: 'k1',
};
const importArgs = {
  bank_account_id: BANK,
  file_type: 'csv',
  content: 'date,description,amount\n2026-08-13,FEE,-100',
  statement_date: '2026-08-13',
  idempotency_key: 'k1',
};

beforeEach(() => {
  vi.clearAllMocks();
  belongsMock.mockResolvedValue(true);
});

// The write tools that call a service which can fail AFTER it has written.
// These used to `catch → toolError`, which RELEASES the registry's savepoint
// and keeps the partial write. That was survivable while a refusal consumed the
// idempotency key (the retry replayed the error); once refusals began auditing
// with a NULL key, the retry re-ran and wrote a second time. Both halves are
// closed by rethrowing, and by answering the genuine pre-write refusals from a
// READ before the service is called at all.
describe('post-write failures must rethrow, not become a tool error', () => {
  it('allocate_bank_transaction rethrows a service failure', async () => {
    const { allocateBankTransactionTool } = await import('@/lib/mcp/tools/writeBankAllocate');
    const lookup = await import('@/modules/accounting/services/bank/bankTransactionLookupService');
    const alloc = await import('@/modules/accounting/services/bank/bankAllocationService');
    vi.mocked(lookup.getBankTransactionStatus).mockResolvedValue('imported');
    // The proven shape: the journal posts, then the row update fails.
    vi.mocked(alloc.allocateTransaction).mockRejectedValue(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );

    await expect(allocateBankTransactionTool.handler(
      { transaction_id: TX, contra_account_id: ACC, idempotency_key: 'k1' }, ctx(),
    )).rejects.toThrow(/deadlock detected/);
  });

  it('allocate_bank_transaction still refuses an already-allocated row precisely, without calling the service', async () => {
    const { allocateBankTransactionTool } = await import('@/lib/mcp/tools/writeBankAllocate');
    const lookup = await import('@/modules/accounting/services/bank/bankTransactionLookupService');
    const alloc = await import('@/modules/accounting/services/bank/bankAllocationService');
    vi.mocked(lookup.getBankTransactionStatus).mockResolvedValue('allocated');

    const r = await allocateBankTransactionTool.handler(
      { transaction_id: TX, contra_account_id: ACC, idempotency_key: 'k1' }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/already allocated/);
    expect(alloc.allocateTransaction).not.toHaveBeenCalled();
  });

  it('reverse_bank_allocation rethrows — the contra posts before the row reset', async () => {
    const { reverseBankAllocationTool } = await import('@/lib/mcp/tools/writeBankAllocate');
    const lookup = await import('@/modules/accounting/services/bank/bankTransactionLookupService');
    const alloc = await import('@/modules/accounting/services/bank/bankAllocationService');
    vi.mocked(lookup.getBankTransactionStatus).mockResolvedValue('allocated');
    vi.mocked(alloc.reverseReconciledTransaction).mockRejectedValue(new Error('reset failed'));

    await expect(reverseBankAllocationTool.handler(
      { transaction_id: TX, idempotency_key: 'k1' }, ctx(),
    )).rejects.toThrow(/reset failed/);
  });

  it('reverse_bank_allocation still refuses an unreversible status precisely', async () => {
    const { reverseBankAllocationTool } = await import('@/lib/mcp/tools/writeBankAllocate');
    const lookup = await import('@/modules/accounting/services/bank/bankTransactionLookupService');
    const alloc = await import('@/modules/accounting/services/bank/bankAllocationService');
    vi.mocked(lookup.getBankTransactionStatus).mockResolvedValue('imported');

    const r = await reverseBankAllocationTool.handler(
      { transaction_id: TX, idempotency_key: 'k1' }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/Can only reverse/);
    expect(alloc.reverseReconciledTransaction).not.toHaveBeenCalled();
  });

  it('undo_bank_import rethrows — it DELETEs, so a partial undo must roll back', async () => {
    const { undoBankImportTool } = await import('@/lib/mcp/tools/writeBankImport');
    undoMock.mockRejectedValue(Object.assign(new Error('canceling statement'), { code: '57014' }));

    await expect(undoBankImportTool.handler(
      { batch_id: BATCH, idempotency_key: 'k1' }, ctx(),
    )).rejects.toThrow(/canceling statement/);
  });
});

describe('create_draft_invoice', () => {
  it('is a write tool, so the registry wraps it in a SAVEPOINT', () => {
    expect(createDraftInvoiceTool.write).toBe(true);
  });

  it('RETHROWS a mid-write failure so the savepoint rolls the header back', async () => {
    // toThrow(regex) matches the MESSAGE only, so asserting on the pg `code`
    // property here would be a dead alternative that can never match.
    createInvoiceMock.mockRejectedValue(Object.assign(new Error('null value in column "amount"'), { code: '23502' }));

    await expect(createDraftInvoiceTool.handler(invoiceArgs, ctx())).rejects.toThrow(/null value in column/);
  });

  it('still reports the pre-write line validation precisely', async () => {
    createInvoiceMock.mockRejectedValue(new InvoiceLineValidationError('Line quantities must be positive'));

    const r = await createDraftInvoiceTool.handler(invoiceArgs, ctx());
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/quantities must be positive/);
  });
});

describe('create_draft_quote', () => {
  it('is a write tool, so the registry wraps it in a SAVEPOINT', () => {
    expect(createDraftQuoteTool.write).toBe(true);
  });

  it('RETHROWS a mid-write failure so the savepoint rolls the header back', async () => {
    // createQuote INSERTs the header, then loops the lines with no transaction.
    createQuoteMock.mockRejectedValue(new Error('deadlock detected'));

    await expect(createDraftQuoteTool.handler(quoteArgs, ctx())).rejects.toThrow(/deadlock/);
  });

  it('still reports the pre-write line validation precisely', async () => {
    createQuoteMock.mockRejectedValue(new LineValidationError('Line "Consulting": quantity must be positive'));

    const r = await createDraftQuoteTool.handler(quoteArgs, ctx());
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/quantity must be positive/);
  });
});

describe('import_bank_statement', () => {
  it('is a write tool, so the registry wraps it in a SAVEPOINT', () => {
    expect(importBankStatementTool.write).toBe(true);
  });

  it('RETHROWS a database failure instead of reporting a tidy tool error', async () => {
    importMock.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(importBankStatementTool.handler(importArgs, ctx())).rejects.toThrow(/connection terminated/);
  });

  it('still reports an unparseable statement precisely', async () => {
    importMock.mockRejectedValue(
      new StatementNotImportableError('No transaction in this statement has a recognisable YYYY-MM-DD date'),
    );

    const r = await importBankStatementTool.handler(importArgs, ctx());
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/recognisable YYYY-MM-DD/);
  });
});
