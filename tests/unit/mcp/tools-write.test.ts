/**
 * MCP write tools — MCP Phase 3, Task 3.2.
 *
 * Per tool: happy path calls the service with ctx.companyId + ctx.userId and
 * the draft/unposted intent; token-scan + additionalProperties:false extended
 * to write tools. Manifest: exactly post_journal + finalize_invoice carry
 * requiresPost. (The registry's scope/write:post/idempotency FENCE is proven
 * generically in registry.test.ts — not re-tested here.)
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
}));
vi.mock('@/modules/accounting/services/ar/quoteService', () => ({ createQuote: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ createJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/core/smartCategorizationService', () => ({ bulkCategorize: vi.fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ customerBelongsToCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ accountsBelongToCompany: vi.fn() }));

import {
  createDraftCustomerInvoice,
  InvoiceLineValidationError,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createQuote } from '@/modules/accounting/services/ar/quoteService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { bulkCategorize } from '@/modules/accounting/services/core/smartCategorizationService';
import { customerBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';

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
  // Default: FK ownership checks pass (customer/accounts belong to the company).
  vi.mocked(customerBelongsToCompany).mockResolvedValue(true);
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
});

describe('create_draft_invoice', () => {
  it('creates a draft via the service with ctx company + user', async () => {
    vi.mocked(createDraftCustomerInvoice).mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-0001' });
    const data = parseOk(await tool('create_draft_invoice').handler(
      { customer_id: 'cust-1', items: [{ description: 'Work', unit_price: 100, quantity: 2 }], ...KEY }, ctx(),
    )) as Record<string, unknown>;
    expect(createDraftCustomerInvoice).toHaveBeenCalledWith(
      COMPANY_ID, USER_ID,
      expect.objectContaining({ clientId: 'cust-1', items: [{ description: 'Work', unitPrice: 100, quantity: 2 }] }),
    );
    expect(data.invoiceNumber).toBe('INV-0001');
  });

  it('rejects a customer_id that belongs to another company (generic not-found, no create)', async () => {
    vi.mocked(customerBelongsToCompany).mockResolvedValue(false);
    const r = await tool('create_draft_invoice').handler(
      { customer_id: 'company-B-customer', items: [{ description: 'x', unit_price: 1 }], ...KEY }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe('Not found');
    expect(customerBelongsToCompany).toHaveBeenCalledWith(COMPANY_ID, 'company-B-customer');
    expect(createDraftCustomerInvoice).not.toHaveBeenCalled();
  });

  it('maps InvoiceLineValidationError to a safe tool error', async () => {
    vi.mocked(createDraftCustomerInvoice).mockRejectedValue(
      new InvoiceLineValidationError('Line unit prices cannot be negative'),
    );
    const r = await tool('create_draft_invoice').handler(
      { customer_id: 'c', items: [{ description: 'x', unit_price: -1 }], ...KEY }, ctx(),
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
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-1', status: 'draft' } as never);
    parseOk(await tool('create_draft_journal').handler({
      date: '2026-06-30', memo: 'Accrual',
      lines: [
        { account_id: 'acc-1', debit: 100, credit: 0 },
        { account_id: 'acc-2', debit: 0, credit: 100 },
      ],
      ...KEY,
    }, ctx()));
    expect(createJournalEntry).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        entryDate: '2026-06-30',
        description: 'Accrual',
        lines: [
          expect.objectContaining({ glAccountId: 'acc-1', debit: 100, credit: 0 }),
          expect.objectContaining({ glAccountId: 'acc-2', debit: 0, credit: 100 }),
        ],
      }),
      USER_ID,
    );
  });

  it('rejects a line whose account_id belongs to another company (no create)', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    const r = await tool('create_draft_journal').handler({
      date: '2026-06-30',
      lines: [
        { account_id: 'company-B-account', debit: 100, credit: 0 },
        { account_id: 'acc-2', debit: 0, credit: 100 },
      ],
      ...KEY,
    }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('not GL accounts in your company');
    expect(accountsBelongToCompany).toHaveBeenCalledWith(COMPANY_ID, ['company-B-account', 'acc-2']);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('surfaces the balance-validation error message from the service', async () => {
    vi.mocked(createJournalEntry).mockRejectedValue(new Error('Invalid journal entry: debits (100) != credits (90)'));
    const r = await tool('create_draft_journal').handler({
      date: '2026-06-30', lines: [{ account_id: 'a', debit: 100, credit: 0 }, { account_id: 'b', debit: 0, credit: 90 }], ...KEY,
    }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('!= credits');
  });
});

describe('suggest_bank_allocation', () => {
  it('records suggestions via bulkCategorize — never applies', async () => {
    vi.mocked(bulkCategorize).mockResolvedValue({ categorized: 2 } as never);
    parseOk(await tool('suggest_bank_allocation').handler(
      { transaction_ids: ['tx-1', 'tx-2'], ...KEY }, ctx(),
    ));
    expect(bulkCategorize).toHaveBeenCalledWith(COMPANY_ID, ['tx-1', 'tx-2']);
  });

  it('rejects an empty id list', async () => {
    const r = await tool('suggest_bank_allocation').handler({ transaction_ids: [], ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(bulkCategorize).not.toHaveBeenCalled();
  });
});

describe('post_journal / finalize_invoice (post tools)', () => {
  it('post_journal posts the existing draft via ctx company + user', async () => {
    vi.mocked(postJournalEntry).mockResolvedValue({ id: 'je-1', status: 'posted' } as never);
    parseOk(await tool('post_journal').handler({ journal_id: 'je-1', ...KEY }, ctx()));
    expect(postJournalEntry).toHaveBeenCalledWith(COMPANY_ID, 'je-1', USER_ID);
  });

  it('finalize_invoice approves the draft via ctx company + user', async () => {
    vi.mocked(approveCustomerInvoice).mockResolvedValue({ id: 'inv-1', status: 'approved', glJournalEntryId: 'je-9' });
    parseOk(await tool('finalize_invoice').handler({ invoice_id: 'inv-1', ...KEY }, ctx()));
    expect(approveCustomerInvoice).toHaveBeenCalledWith(COMPANY_ID, 'inv-1', USER_ID);
  });
});

describe('write-tool failure paths', () => {
  it('create_draft_quote: service rejection → safe tool error', async () => {
    vi.mocked(createQuote).mockRejectedValue(new Error('Line quantities must be positive'));
    const r = await tool('create_draft_quote').handler(
      { customer_name: 'A', items: [{ description: 'x', unit_price: 1 }], ...KEY }, ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('positive'); // plain Error → surfaced
  });

  it('suggest_bank_allocation: service rejection → safe tool error', async () => {
    vi.mocked(bulkCategorize).mockRejectedValue(new Error('no accounts configured'));
    const r = await tool('suggest_bank_allocation').handler({ transaction_ids: ['t1'], ...KEY }, ctx());
    expect(r.isError).toBe(true);
  });

  it('post_journal: service rejection → safe tool error', async () => {
    vi.mocked(postJournalEntry).mockRejectedValue(new Error('Cannot post entry with status: posted'));
    const r = await tool('post_journal').handler({ journal_id: 'je-1', ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('status'); // application error surfaced
  });

  it('finalize_invoice: already-cancelled → safe tool error', async () => {
    vi.mocked(approveCustomerInvoice).mockRejectedValue(new Error('Invoice is not in an approvable state'));
    const r = await tool('finalize_invoice').handler({ invoice_id: 'inv-1', ...KEY }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('approvable');
  });

  it('generic-ifies pg driver errors (with a SQLSTATE code) — no schema leak', async () => {
    vi.mocked(createJournalEntry).mockRejectedValue(
      Object.assign(new Error('column "gl_account_idx" does not exist'), { code: '42703' }),
    );
    const r = await tool('create_draft_journal').handler({
      date: '2026-06-30',
      lines: [{ account_id: 'a', debit: 1, credit: 0 }, { account_id: 'b', debit: 0, credit: 1 }],
      ...KEY,
    }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).not.toContain('gl_account_idx');
    expect(r.content[0]!.text).not.toContain('column');
    expect(r.content[0]!.text).toContain('balances'); // generic fallback
  });
});

describe('write-tool manifest invariants', () => {
  const WRITE_NAMES = [
    'create_draft_invoice', 'create_draft_quote', 'create_draft_journal',
    'suggest_bank_allocation', 'post_journal', 'finalize_invoice',
  ];

  it('all six write tools are write:true with additionalProperties:false + idempotency_key', () => {
    for (const name of WRITE_NAMES) {
      const t = tool(name);
      expect(t.write).toBe(true);
      const schema = t.inputSchema as { additionalProperties?: boolean; properties?: Record<string, unknown>; required?: string[] };
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {})).toContain('idempotency_key');
      expect(schema.required).toContain('idempotency_key');
    }
  });

  it('exactly post_journal + finalize_invoice require write:post', () => {
    const requiresPost = MCP_TOOLS.filter((t) => t.requiresPost).map((t) => t.name).sort();
    expect(requiresPost).toEqual(['finalize_invoice', 'post_journal']);
  });

  it('no write tool accepts a company identifier in its schema', () => {
    for (const name of WRITE_NAMES) {
      const props = Object.keys(
        ((tool(name).inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
      );
      for (const p of props) expect(p).not.toMatch(/company/i);
    }
  });

  it('token-scan: no credential material in write-tool results or manifest', async () => {
    vi.mocked(createDraftCustomerInvoice).mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1' });
    vi.mocked(createQuote).mockResolvedValue({ id: 'q-1' } as never);
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-1' } as never);
    vi.mocked(bulkCategorize).mockResolvedValue({ categorized: 0 } as never);
    vi.mocked(postJournalEntry).mockResolvedValue({ id: 'je-1' } as never);
    vi.mocked(approveCustomerInvoice).mockResolvedValue({ id: 'inv-1', status: 'approved', glJournalEntryId: null });

    const argsByTool: Record<string, Record<string, unknown>> = {
      create_draft_invoice: { customer_id: 'c', items: [{ description: 'x', unit_price: 1 }], ...KEY },
      create_draft_quote: { customer_name: 'A', items: [{ description: 'x', unit_price: 1 }], ...KEY },
      create_draft_journal: { date: '2026-06-30', lines: [{ account_id: 'a', debit: 1, credit: 0 }, { account_id: 'b', debit: 0, credit: 1 }], ...KEY },
      suggest_bank_allocation: { transaction_ids: ['t1'], ...KEY },
      post_journal: { journal_id: 'je-1', ...KEY },
      finalize_invoice: { invoice_id: 'inv-1', ...KEY },
    };
    let corpus = JSON.stringify(MCP_TOOLS.map((t) => ({ n: t.name, s: t.inputSchema })));
    for (const name of WRITE_NAMES) {
      corpus += JSON.stringify(await tool(name).handler(argsByTool[name]!, ctx()));
    }
    for (const needle of ['pat_', 'oat_', 'ort_', 'cls_', 'Bearer ', 'apikey', 'Set-Cookie']) {
      expect(corpus).not.toContain(needle);
    }
  });
});
