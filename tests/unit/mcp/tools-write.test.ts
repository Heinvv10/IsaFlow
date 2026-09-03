/**
 * MCP write tools — MCP Phase 3, Task 3.2.
 *
 * Per tool: happy path calls the service with ctx.companyId + ctx.userId and
 * the draft/unposted intent; token-scan + additionalProperties:false extended
 * to write tools. Manifest: exactly post_journal + finalize_invoice +
 * allocate_bank_transaction + reverse_bank_allocation + the bulk batch pair
 * carry requiresPost. (The registry's
 * scope/write:post/idempotency FENCE is proven generically in registry.test.ts
 * — not re-tested here. allocate_bank_transaction's own behaviour is covered
 * in writeBankAllocate.test.ts, same pattern as bankMatchTool.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlFn = Object.assign(vi.fn().mockResolvedValue([]), {
    transaction: vi.fn(),
  });
  return {
    sql: sqlFn,
    fmtDate: vi.fn(() => '2026-07-19'),
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
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', () => ({
  approveCustomerInvoice: vi.fn(),
  // finalize_invoice does `err instanceof InvoiceNotApprovableError` to decide
  // whether a failure is safe to report as a tool error or must be rethrown so
  // the registry's SAVEPOINT rolls the write back. Omitting it from this mock
  // makes that `instanceof` throw a TypeError against undefined.
  InvoiceNotApprovableError: class InvoiceNotApprovableError extends Error {},
}));
vi.mock('@/modules/accounting/services/ar/quoteService', () => ({
  createQuote: vi.fn(),
  // create_draft_quote narrows on this to decide swallow-vs-rethrow; omitting
  // it leaves `instanceof` testing against undefined.
  LineValidationError: class LineValidationError extends Error {},
}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: vi.fn(),
  // post_journal answers its two refusals from this READ so the service call
  // that follows can rethrow — a caught mid-write failure would otherwise be
  // reported as a tool error, freeing the key for a retry that posts twice.
  getJournalEntryById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/core/smartCategorizationService', () => ({ bulkCategorize: vi.fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customerBelongsToCompany: vi.fn(),
  supplierBelongsToCompany: vi.fn(),
  customersBelongToCompany: vi.fn(),
  suppliersBelongToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ accountsBelongToCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/bank/bankAllocationService', () => ({
  allocateTransaction: vi.fn(),
  reverseReconciledTransaction: vi.fn(),
}));
// allocate/reverse answer their pre-write refusals from this read so the
// service calls that follow can rethrow.
vi.mock('@/modules/accounting/services/bank/bankTransactionLookupService', () => ({
  findBankTransactionsByReference: vi.fn(),
  // Batched resolution (one query per bulk call) — the plural is what the
  // selector resolver actually calls; default to "nothing matched".
  findBankTransactionsByReferences: vi.fn(async () => new Map()),
  getBankTransactionStatus: vi.fn(),
  // Current allocation state of a bulk batch's resolved rows, read in one
  // query before anything posts. Unstubbed here: the bulk tool is driven down
  // a dry run, and an empty map makes every line "not in this company", which
  // is a pre-write refusal — an error envelope is still an envelope.
  findBankTransactionAllocationStates: vi.fn(async () => new Map()),
}));

import {
  createDraftCustomerInvoice,
  InvoiceLineValidationError,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import {
  approveCustomerInvoice,
  InvoiceNotApprovableError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createQuote, LineValidationError } from '@/modules/accounting/services/ar/quoteService';
import { createJournalEntry, getJournalEntryById } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { bulkCategorize } from '@/modules/accounting/services/core/smartCategorizationService';
import {
  customerBelongsToCompany,
  customersBelongToCompany,
  suppliersBelongToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getBankTransactionStatus } from '@/modules/accounting/services/bank/bankTransactionLookupService';

import { MCP_TOOLS } from '@/lib/mcp/toolIndex';
import type { McpTool, McpToolContext } from '@/lib/mcp/types';

const COMPANY_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = 'user-gotrue-1';

function ctx(): McpToolContext {
  return {
    userId: USER_ID,
    companyId: COMPANY_ID,
    scopes: ['write:invoices', 'write:journals', 'write:bank-tx', 'write:post'],
    tokenJti: 'jti-1',
    oauthAppId: null,
  };
}

function tool(name: string): McpTool {
  const t = MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t;
}

function parseOk(r: { content: Array<{ text: string }>; isError?: boolean }): unknown {
  expect(r.isError).toBeUndefined();
  return JSON.parse(r.content[0]!.text);
}

const KEY = { idempotency_key: 'k1' };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: FK ownership checks pass (customer/supplier/accounts belong to the company).
  vi.mocked(customerBelongsToCompany).mockResolvedValue(true);
  vi.mocked(customersBelongToCompany).mockResolvedValue(true);
  vi.mocked(suppliersBelongToCompany).mockResolvedValue(true);
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  // Default: the journal exists and is still a draft.
  vi.mocked(getJournalEntryById).mockResolvedValue({ id: 'je-1', status: 'draft' } as never);
  vi.mocked(getBankTransactionStatus).mockResolvedValue('imported');
});

describe('create_draft_invoice', () => {
  it('creates a draft via the service with ctx company + user', async () => {
    vi.mocked(createDraftCustomerInvoice).mockResolvedValue({ id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', invoiceNumber: 'INV-0001' });
    const data = parseOk(await tool('create_draft_invoice').handler(
      { customer_id: '21d12090-6fd3-44b1-8c7a-5ea3e84254bb', items: [{ description: 'Work', unit_price: 100, quantity: 2 }], ...KEY }, ctx(),
    )) as Record<string, unknown>;
    expect(createDraftCustomerInvoice).toHaveBeenCalledWith(
      COMPANY_ID, USER_ID,
      expect.objectContaining({ clientId: '21d12090-6fd3-44b1-8c7a-5ea3e84254bb', items: [{ description: 'Work', unitPrice: 100, quantity: 2 }] }),
      // The document itself records the actor: a draft invoice posts no
      // journal, so until approval this is the only trace of who raised it.
      { postingAgent: 'mcp:create_draft_invoice:v1', actorType: 'agent', actorTokenJti: 'jti-1' },
    );
    expect(data.invoiceNumber).toBe('INV-0001');
  });

  it('rejects a customer_id that belongs to another company (generic not-found, no create)', async () => {
    vi.mocked(customerBelongsToCompany).mockResolvedValue(false);
    const r = await tool('create_draft_invoice').handler(
      { customer_id: '58a4fa7b-0ead-430d-8acc-071b902f5d2f', items: [{ description: 'x', unit_price: 1 }], ...KEY }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
    expect(customerBelongsToCompany).toHaveBeenCalledWith(COMPANY_ID, '58a4fa7b-0ead-430d-8acc-071b902f5d2f');
    expect(createDraftCustomerInvoice).not.toHaveBeenCalled();
  });

  it('maps InvoiceLineValidationError to a safe tool error', async () => {
    vi.mocked(createDraftCustomerInvoice).mockRejectedValue(
      new InvoiceLineValidationError('Line unit prices cannot be negative'),
    );
    const r = await tool('create_draft_invoice').handler(
      { customer_id: 'd0ac03be-abe5-44c4-80a2-0d99d9d3e3e6', items: [{ description: 'x', unit_price: -1 }], ...KEY }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('negative');
  });
});

describe('create_draft_quote', () => {
  it('creates a draft quote via createQuote(companyId, input, userId)', async () => {
    vi.mocked(createQuote).mockResolvedValue({ id: 'q-1', status: 'draft' } as never);
    parseOk(await tool('create_draft_quote').handler(
      { customer_name: 'Acme', items: [{ description: 'Design', unit_price: 500 }], ...KEY }, ctx(),
    ));
    expect(createQuote).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ customerName: 'Acme', lines: [{ description: 'Design', quantity: 1, unitPrice: 500 }] }),
      USER_ID,
    );
  });
});

describe('create_draft_journal', () => {
  it('creates an unposted entry; lines map account_id → glAccountId', async () => {
    vi.mocked(createJournalEntry).mockResolvedValue({ id: '97120700-9f09-4fe5-804e-34331ce49b97', status: 'draft' } as never);
    parseOk(await tool('create_draft_journal').handler({
      date: '2026-06-30', memo: 'Accrual',
      lines: [
        { account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', debit: 100, credit: 0 },
        { account_id: 'a75990ab-7ebf-48a9-86bd-35b744c781c2', debit: 0, credit: 100 },
      ],
      ...KEY,
    }, ctx()));
    expect(createJournalEntry).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        entryDate: '2026-06-30',
        description: 'Accrual',
        lines: [
          expect.objectContaining({ glAccountId: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', debit: 100, credit: 0 }),
          expect.objectContaining({ glAccountId: 'a75990ab-7ebf-48a9-86bd-35b744c781c2', debit: 0, credit: 100 }),
        ],
      }),
      USER_ID,
      { postingAgent: 'mcp:create_draft_journal:v1', actorType: 'agent', actorTokenJti: 'jti-1' },
    );
  });

  // ── Attribution: the draft path must not post as the token owner ──────────
  // createJournalEntry falls back to defaultHumanMeta(userId) when meta is
  // omitted, so an unstamped draft lands as human:<userId>: agent work
  // affirmatively labelled as the human's own, and invisible to
  // list_agent_postings (posting_agent LIKE 'mcp:%'). post_journal does not
  // restamp, so the mislabel survives posting.
  it('stamps the draft with the MCP tool, not the human default', async () => {
    vi.mocked(createJournalEntry).mockResolvedValue({ id: '97120700-9f09-4fe5-804e-34331ce49b97', status: 'draft' } as never);
    await tool('create_draft_journal').handler({
      date: '2026-06-30',
      lines: [{ account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', debit: 1, credit: 0 }, { account_id: 'a75990ab-7ebf-48a9-86bd-35b744c781c2', debit: 0, credit: 1 }],
      ...KEY,
    }, ctx());

    const meta = vi.mocked(createJournalEntry).mock.calls[0]![3];
    expect(meta).toEqual({ postingAgent: 'mcp:create_draft_journal:v1', actorType: 'agent', actorTokenJti: 'jti-1' });
    expect(meta?.postingAgent).not.toContain('human:');
  });

  it('rejects a line whose account_id belongs to another company (no create)', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    const r = await tool('create_draft_journal').handler({
      date: '2026-06-30',
      lines: [
        { account_id: 'f8849626-ab9e-4219-8501-a6c72135d281', debit: 100, credit: 0 },
        { account_id: 'a75990ab-7ebf-48a9-86bd-35b744c781c2', debit: 0, credit: 100 },
      ],
      ...KEY,
    }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('not GL accounts in your company');
    expect(accountsBelongToCompany).toHaveBeenCalledWith(COMPANY_ID, ['f8849626-ab9e-4219-8501-a6c72135d281', 'a75990ab-7ebf-48a9-86bd-35b744c781c2']);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('surfaces the balance-validation error message from the service', async () => {
    vi.mocked(createJournalEntry).mockRejectedValue(new Error('Invalid journal entry: debits (100) != credits (90)'));
    const r = await tool('create_draft_journal').handler({
      date: '2026-06-30', lines: [{ account_id: 'ddd887ce-a246-46cb-898c-2bd2f4ddecfe', debit: 100, credit: 0 }, { account_id: '3413c139-d94c-48bd-8513-baff94ff4818', debit: 0, credit: 90 }], ...KEY,
    }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('!= credits');
  });
});

describe('suggest_bank_allocation', () => {
  it('records suggestions via bulkCategorize — never applies', async () => {
    vi.mocked(bulkCategorize).mockResolvedValue({ categorized: 2 } as never);
    parseOk(await tool('suggest_bank_allocation').handler(
      { transaction_ids: ['045ef594-d81d-4f21-84d6-1151ed71260d', '0ab25f30-4900-4ce5-8691-00672c92a276'], ...KEY }, ctx(),
    ));
    expect(bulkCategorize).toHaveBeenCalledWith(COMPANY_ID, ['045ef594-d81d-4f21-84d6-1151ed71260d', '0ab25f30-4900-4ce5-8691-00672c92a276']);
  });

  it('rejects an empty id list', async () => {
    const r = await tool('suggest_bank_allocation').handler({ transaction_ids: [], ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(bulkCategorize).not.toHaveBeenCalled();
  });
});

describe('post_journal / finalize_invoice (post tools)', () => {
  it('post_journal posts the existing draft via ctx company + user', async () => {
    vi.mocked(postJournalEntry).mockResolvedValue({ id: '97120700-9f09-4fe5-804e-34331ce49b97', status: 'posted' } as never);
    parseOk(await tool('post_journal').handler({ journal_id: '97120700-9f09-4fe5-804e-34331ce49b97', ...KEY }, ctx()));
    expect(postJournalEntry).toHaveBeenCalledWith(COMPANY_ID, '97120700-9f09-4fe5-804e-34331ce49b97', USER_ID);
  });

  it('finalize_invoice approves the draft via ctx company + user', async () => {
    vi.mocked(approveCustomerInvoice).mockResolvedValue({ id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', status: 'approved', glJournalEntryId: 'je-9', evidenceDocumentId: null });
    parseOk(await tool('finalize_invoice').handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', ...KEY }, ctx()));
    expect(approveCustomerInvoice).toHaveBeenCalledWith(
      COMPANY_ID, 'eec03106-2910-4a7a-8e91-0c4f396ec98f', USER_ID,
      { postingAgent: 'mcp:finalize_invoice:v1', actorType: 'agent', actorTokenJti: 'jti-1' },
    );
  });

  // Approval POSTS the AR journal. Unstamped, that journal reads as
  // human:<userId> and never appears in list_agent_postings — the review
  // surface would show nothing while the agent had posted revenue.
  it('finalize_invoice stamps the AR journal as agent work, not the token owner', async () => {
    vi.mocked(approveCustomerInvoice).mockResolvedValue({ id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', status: 'approved', glJournalEntryId: 'je-9', evidenceDocumentId: null });
    await tool('finalize_invoice').handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', ...KEY }, ctx());

    const opts = vi.mocked(approveCustomerInvoice).mock.calls[0]![3];
    expect(opts?.postingAgent).toBe('mcp:finalize_invoice:v1');
    expect(opts?.postingAgent).not.toContain('human:');
  });

  it('every MCP posting path stamps mcp:<tool>:v1 — none silently defaults to human', async () => {
    vi.mocked(createJournalEntry).mockResolvedValue({ id: '97120700-9f09-4fe5-804e-34331ce49b97' } as never);
    vi.mocked(approveCustomerInvoice).mockResolvedValue({ id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', status: 'approved', glJournalEntryId: null, evidenceDocumentId: null });
    vi.mocked(allocateTransaction).mockResolvedValue({ journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '045ef594-d81d-4f21-84d6-1151ed71260d' } } as never);
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);

    await tool('create_draft_journal').handler({
      date: '2026-06-30',
      lines: [{ account_id: 'ddd887ce-a246-46cb-898c-2bd2f4ddecfe', debit: 1, credit: 0 }, { account_id: '3413c139-d94c-48bd-8513-baff94ff4818', debit: 0, credit: 1 }], ...KEY,
    }, ctx());
    await tool('finalize_invoice').handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', ...KEY }, ctx());
    await tool('allocate_bank_transaction').handler({ transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', ...KEY }, ctx());
    // Reverse needs a row that HAS an allocation to undo.
    vi.mocked(getBankTransactionStatus).mockResolvedValue('allocated');
    await tool('reverse_bank_allocation').handler({ transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', ...KEY }, ctx());

    const stamps = [
      vi.mocked(createJournalEntry).mock.calls[0]![3]?.postingAgent,
      vi.mocked(approveCustomerInvoice).mock.calls[0]![3]?.postingAgent,
      vi.mocked(allocateTransaction).mock.calls[0]![12]?.postingAgent,
      vi.mocked(reverseReconciledTransaction).mock.calls[0]![3]?.postingAgent,
    ];

    expect(stamps).toEqual([
      'mcp:create_draft_journal:v1',
      'mcp:finalize_invoice:v1',
      'mcp:allocate_bank_transaction:v1',
      'mcp:reverse_bank_allocation:v1',
    ]);
    // list_agent_postings filters posting_agent LIKE 'mcp:%'; anything else is invisible to it.
    for (const s of stamps) expect(s).toMatch(/^mcp:/);
  });
});

describe('write-tool failure paths', () => {
  // The fixture must be a LineValidationError — that is what quoteService
  // actually throws for this case (quoteService.ts:110), and it is raised
  // BEFORE the header INSERT so nothing was written. A plain Error here never
  // matched production, and create_draft_quote now rethrows anything untyped so
  // the registry's savepoint can discard a partial quote.
  it('create_draft_quote: line-validation rejection → safe tool error', async () => {
    vi.mocked(createQuote).mockRejectedValue(new LineValidationError('Line quantities must be positive'));
    const r = await tool('create_draft_quote').handler(
      { customer_name: 'A', items: [{ description: 'x', unit_price: 1 }], ...KEY }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('positive'); // plain Error → surfaced
  });

  it('suggest_bank_allocation: service rejection → safe tool error', async () => {
    vi.mocked(bulkCategorize).mockRejectedValue(new Error('no accounts configured'));
    const r = await tool('suggest_bank_allocation').handler({ transaction_ids: ['045ef594-d81d-4f21-84d6-1151ed71260d'], ...KEY }, ctx());
    expect(r.isError).toBe(true);
  });

  it('post_journal: an already-posted entry is refused precisely, before the service', async () => {
    // The refusal moved from a catch to a pre-write read. It has to: a catch
    // around postJournalEntry cannot tell this from a failure after the status
    // UPDATE landed, and a refusal frees the idempotency key.
    vi.mocked(getJournalEntryById).mockResolvedValue({ id: 'je-1', status: 'posted' } as never);
    const r = await tool('post_journal').handler({ journal_id: '97120700-9f09-4fe5-804e-34331ce49b97', ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('status'); // application error surfaced
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('post_journal: a service failure RETHROWS so the savepoint unwinds it', async () => {
    vi.mocked(postJournalEntry).mockRejectedValue(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    );
    await expect(
      tool('post_journal').handler({ journal_id: '97120700-9f09-4fe5-804e-34331ce49b97', ...KEY }, ctx()),
    ).rejects.toThrow(/deadlock detected/);
  });

  // The fixture must be an InvoiceNotApprovableError, which is what the service
  // actually throws for this case (customerInvoiceApprovalService.ts:76) — a
  // plain Error here never matched production. finalize_invoice now rethrows
  // anything that is NOT that typed error, so the write-tool SAVEPOINT can roll
  // back a failure that happened AFTER the status UPDATE. Only the pre-write
  // guard, where the guarded UPDATE matched zero rows, is a safe tool error.
  it('finalize_invoice: already-cancelled → safe tool error', async () => {
    vi.mocked(approveCustomerInvoice).mockRejectedValue(
      new InvoiceNotApprovableError('Invoice is not in an approvable state'),
    );
    const r = await tool('finalize_invoice').handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('approvable');
  });

  it('finalize_invoice: GL post failure PROPAGATES so the savepoint rolls back', async () => {
    vi.mocked(approveCustomerInvoice).mockRejectedValue(new Error('Cannot post to closed fiscal period'));
    await expect(
      tool('finalize_invoice').handler({ invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', ...KEY }, ctx()),
    ).rejects.toThrow(/closed fiscal period/);
  });

  it('generic-ifies pg driver errors (with a SQLSTATE code) — no schema leak', async () => {
    vi.mocked(createJournalEntry).mockRejectedValue(
      Object.assign(new Error('column "gl_account_idx" does not exist'), { code: '42703' }),
    );
    const r = await tool('create_draft_journal').handler({
      date: '2026-06-30',
      lines: [{ account_id: 'ddd887ce-a246-46cb-898c-2bd2f4ddecfe', debit: 1, credit: 0 }, { account_id: '3413c139-d94c-48bd-8513-baff94ff4818', debit: 0, credit: 1 }],
      ...KEY,
    }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain('gl_account_idx');
    expect(r.content[0]!.text).not.toContain('column');
    expect(r.content[0]!.text).toContain('balances'); // generic fallback
  });
});

describe('write-tool manifest invariants', () => {
  // Derived from the registry, not hand-listed: a hand-listed array silently
  // stops covering each new write tool, which is exactly what happened when
  // import_bank_statement and undo_bank_import were added — these invariants
  // then guarded 8 of 10 tools while still claiming "all eight".
  const WRITE_NAMES = MCP_TOOLS.filter((t) => t.write).map((t) => t.name);

  it('every write tool is registered write:true with additionalProperties:false + idempotency_key', () => {
    expect(WRITE_NAMES.length).toBeGreaterThanOrEqual(10);
    for (const name of WRITE_NAMES) {
      const t = tool(name);
      expect(t.write).toBe(true);
      const schema = t.inputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: string[] };
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {})).toContain('idempotency_key');
      expect(schema.required).toContain('idempotency_key');
    }
  });

  it('exactly the posting tools require write:post — the batch pair included', () => {
    const requiresPost = MCP_TOOLS.filter((t) => t.requiresPost).map((t) => t.name).sort();
    expect(requiresPost).toEqual([
      'allocate_bank_transaction', 'apply_payment_to_supplier_invoice',
      'apply_receipt_to_invoice',
      'approve_credit_note',
      'approve_supplier_invoice',
      'bulk_allocate_bank_transactions', 'cancel_credit_note', 'finalize_invoice',
      'post_journal', 'reverse_allocations', 'reverse_bank_allocation',
      'reverse_bank_allocation_batch', 'reverse_journal_entry',
      'set_opening_balance', 'settle_by_contra',
    ]);
  });

  it('no write tool accepts a company identifier in its schema', () => {
    for (const name of WRITE_NAMES) {
      const props = Object.keys(
        ((tool(name).inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      );
      for (const p of props) expect(p).not.toMatch(/company/i);
    }
  });

  /**
   * The registry does NOT validate args against inputSchema — getManifest only
   * decorates it (registry.ts). So `required`, `enum`, `exclusiveMinimum` and
   * `additionalProperties: false` are advisory to the MODEL, not enforced: a
   * handler that trusts its schema is trusting nothing.
   *
   * What this pins: called with the idempotency key alone, no write tool may
   * answer with a SUCCESS envelope. That is the shape that matters — a handler
   * reading a required argument as undefined and carrying on into a write.
   *
   * What it does NOT pin, deliberately stated rather than implied: it does not
   * prove the refusal came from an explicit argument check. A tool that drops
   * its `if (!id) return toolError(...)` guard usually still refuses, one step
   * later, when the id it invented misses its ownership read — verified by
   * mutation, and that mutant survives this test. Per-tool argument handling is
   * covered in each tool's own suite; this is the floor beneath all of them.
   */
  it('every write tool refuses when called with only an idempotency key', async () => {
    for (const name of WRITE_NAMES) {
      const r = await tool(name).handler({ ...KEY }, ctx());
      expect(r.isError, `${name} did not refuse a call carrying no arguments`).toBe(true);
    }
  });

  it('token-scan: no credential material in write-tool results or manifest', async () => {
    vi.mocked(createDraftCustomerInvoice).mockResolvedValue({ id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', invoiceNumber: 'INV-1' });
    vi.mocked(createQuote).mockResolvedValue({ id: 'q-1' } as never);
    vi.mocked(createJournalEntry).mockResolvedValue({ id: '97120700-9f09-4fe5-804e-34331ce49b97' } as never);
    vi.mocked(bulkCategorize).mockResolvedValue({ categorized: 0 } as never);
    vi.mocked(postJournalEntry).mockResolvedValue({ id: '97120700-9f09-4fe5-804e-34331ce49b97' } as never);
    vi.mocked(approveCustomerInvoice).mockResolvedValue({ id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', status: 'approved', glJournalEntryId: null });
    vi.mocked(allocateTransaction).mockResolvedValue({ journalEntryId: '97120700-9f09-4fe5-804e-34331ce49b97', bankTransaction: { id: '045ef594-d81d-4f21-84d6-1151ed71260d' } } as never);
    vi.mocked(reverseReconciledTransaction).mockResolvedValue(undefined);

    const argsByTool: Record<string, Record<string, unknown>> = {
      create_draft_invoice: { customer_id: 'd0ac03be-abe5-44c4-80a2-0d99d9d3e3e6', items: [{ description: 'x', unit_price: 1 }], ...KEY },
      create_draft_quote: { customer_name: 'A', items: [{ description: 'x', unit_price: 1 }], ...KEY },
      create_draft_journal: { date: '2026-06-30', lines: [{ account_id: 'ddd887ce-a246-46cb-898c-2bd2f4ddecfe', debit: 1, credit: 0 }, { account_id: '3413c139-d94c-48bd-8513-baff94ff4818', debit: 0, credit: 1 }], ...KEY },
      suggest_bank_allocation: { transaction_ids: ['045ef594-d81d-4f21-84d6-1151ed71260d'], ...KEY },
      post_journal: { journal_id: '97120700-9f09-4fe5-804e-34331ce49b97', ...KEY },
      finalize_invoice: { invoice_id: 'eec03106-2910-4a7a-8e91-0c4f396ec98f', ...KEY },
      allocate_bank_transaction: { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73', ...KEY },
      reverse_bank_allocation: { transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', ...KEY },
      bulk_allocate_bank_transactions: {
        allocations: [{ transaction_id: '045ef594-d81d-4f21-84d6-1151ed71260d', contra_account_id: 'cf9df9b9-9fc0-424b-8137-47e9ba144c73' }],
        dry_run: true, ...KEY,
      },
      // Driven down its NOT_FOUND path: the batch lookup hits the mocked sql,
      // which returns no rows. An error envelope is still an envelope.
      reverse_bank_allocation_batch: { batch_id: '0f000000-0000-4000-8000-000000000001', ...KEY },
      // These two reach services this file does not mock, so they are driven
      // down their argument-validation path instead. The scan cares about what
      // ends up in the envelope, and an error envelope is still an envelope.
      import_bank_statement: { ...KEY },
      undo_bank_import: { ...KEY },
      // Same treatment for the chart-of-accounts and AP tools: each refuses on
      // a missing required argument BEFORE touching a service, which is the
      // only path available in a file that does not mock those services.
      // Dedicated behaviour tests live in writeGlAccountsTool.test.ts and
      // writeSupplierInvoicesTool.test.ts.
      create_gl_account: { ...KEY },
      update_gl_account: { ...KEY },
      deactivate_gl_account: { ...KEY },
      create_supplier_invoice: { ...KEY },
      approve_supplier_invoice: { ...KEY },
      // Bank-rule writes refuse on a missing required argument before touching
      // a service; behaviour is covered in bankRulesTools.test.ts.
      create_bank_rule: { ...KEY },
      update_bank_rule: { ...KEY },
      disable_bank_rule: { ...KEY },
      reverse_allocations: { ...KEY },
      set_opening_balance: { ...KEY },
      // Refuses on the missing file_name before any lookup; behaviour in attachDocumentTool.test.ts.
      attach_document: { ...KEY },
      // Refuses on the missing reconciliation_id before any lookup; behaviour
      // in bankReconciliationTools.test.ts.
      cancel_bank_reconciliation: { ...KEY },
      // All four practice write tools refuse on a missing required argument
      // before touching the database; behaviour in practiceTools.test.ts.
      create_job_category: { ...KEY },
      create_work_item: { ...KEY },
      log_time_entry: { ...KEY },
      submit_time_entries: { ...KEY },
      // Credit-note writes each refuse on a missing required argument before
      // touching a service; behaviour in creditNoteTools.test.ts.
      create_credit_note: { ...KEY },
      approve_credit_note: { ...KEY },
      cancel_credit_note: { ...KEY },
      // Refuses on neither-source-named before any lookup; behaviour in
      // applyReceiptTool.test.ts.
      apply_receipt_to_invoice: { ...KEY },
      apply_payment_to_supplier_invoice: { ...KEY },
      // Refuses on the missing journal_entry_id before any lookup.
      reverse_journal_entry: { ...KEY },
      // Refuses on the missing subledger before any lookup.
      settle_by_contra: { ...KEY },
      // Each refuses on its missing required argument before any lookup.
      create_customer: { ...KEY },
      update_customer: { ...KEY },
      create_supplier: { ...KEY },
      update_supplier: { ...KEY },
    };
    let corpus = JSON.stringify(MCP_TOOLS.map((t) => ({ n: t.name, s: t.inputSchema })));
    for (const name of WRITE_NAMES) {
      corpus += JSON.stringify(await tool(name).handler(argsByTool[name]!, ctx()));
    }
    // Shape-based credential matching — see the same scan in tools-read.test.ts
    // for why prefix + >=16 alphanumerics beats both a substring scan (false
    // positive on import_bank_statement) and a boundary rule (misses a token
    // glued to a preceding word).
    for (const prefix of ['pat_', 'oat_', 'ort_', 'cls_']) {
      expect(corpus).not.toMatch(new RegExp(`${prefix}[A-Za-z0-9]{16,}`));
    }
    for (const needle of ['Bearer ', 'apikey', 'Set-Cookie']) {
      expect(corpus).not.toContain(needle);
    }
  });
});
