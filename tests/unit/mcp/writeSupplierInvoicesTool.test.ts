/**
 * create_supplier_invoice / approve_supplier_invoice.
 *
 * What is worth pinning:
 *
 *  - ownership of supplier_id and every line's gl_account_id is answered
 *    BEFORE the first write, with the generic miss text.
 *  - line faults refuse with the offending INDEX, pre-write, so a 200-line
 *    bill never has to be bisected by hand.
 *  - approve stamps `mcp:approve_supplier_invoice:v1`. Without it
 *    createJournalEntry falls back to defaultHumanMeta(userId), labelling agent
 *    work as the token owner's own and hiding it from list_agent_postings.
 *  - approve answers its status refusal from a READ and RETHROWS everything
 *    else: a refusal is audited with a NULL idempotency key, so a
 *    catch-and-return after the journal posted would let the agent's retry post
 *    the invoice a second time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', () => ({
  createSupplierInvoice: vi.fn(),
  getSupplierInvoiceById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({
  approveSupplierInvoice: vi.fn(),
}));
vi.mock('@/modules/accounting/services/capture/capturedVatEvidence', () => ({
  CAPTURED_VAT_UNEVIDENCED_REASON: 'its VAT is not evidenced by its captured document',
  invoicesWithUnevidencedVat: vi.fn(async () => new Set<string>()),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  supplierBelongsToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn(),
}));

import {
  createSupplierInvoice,
  getSupplierInvoiceById,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { invoicesWithUnevidencedVat } from '@/modules/accounting/services/capture/capturedVatEvidence';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  createSupplierInvoiceTool,
  approveSupplierInvoiceTool,
} from '@/lib/mcp/tools/writeSupplierInvoices';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const INVOICE = '77777777-7777-4777-8777-777777777777';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '44444444-4444-4444-8444-444444444444',
    companyId: COMPANY,
    scopes: ['write:invoices', 'write:post'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}

function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

const GOOD_LINE = { description: 'Fibre spool', quantity: 2, unit_price: 500 };
function createArgs(over: Record<string, unknown> = {}) {
  return {
    supplier_id: SUPPLIER,
    invoice_number: 'INV-9001',
    invoice_date: '2026-06-30',
    lines: [GOOD_LINE],
    ...KEY,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(supplierBelongsToCompany).mockResolvedValue(true);
  vi.mocked(accountsBelongToCompany).mockResolvedValue(true);
  vi.mocked(createSupplierInvoice).mockResolvedValue({
    id: INVOICE, invoiceNumber: 'INV-9001', supplierId: SUPPLIER,
    invoiceDate: '2026-06-30', subtotal: 1000, taxAmount: 150,
    totalAmount: 1150, status: 'draft',
  } as never);
});

describe('create_supplier_invoice', () => {
  it('creates a DRAFT against the token company and posts nothing', async () => {
    const r = parseOk(await createSupplierInvoiceTool.handler(createArgs(), ctx()));
    expect(r.status).toBe('draft');
    expect(vi.mocked(createSupplierInvoice).mock.calls[0]![0]).toBe(COMPANY);
    expect(vi.mocked(createSupplierInvoice).mock.calls[0]![2]).toBe(ctx().userId);
    // Not a posting tool: the ledger is only touched by approve.
    expect(createSupplierInvoiceTool.requiresPost).toBeUndefined();
  });

  it('checks supplier ownership BEFORE writing, with the generic miss text', async () => {
    vi.mocked(supplierBelongsToCompany).mockResolvedValue(false);
    const r = await createSupplierInvoiceTool.handler(createArgs(), ctx());
    expect(errText(r)).toBe('Not found');
    expect(createSupplierInvoice).not.toHaveBeenCalled();
  });

  it('checks every line gl_account_id in ONE batched call, before writing', async () => {
    vi.mocked(accountsBelongToCompany).mockResolvedValue(false);
    const r = await createSupplierInvoiceTool.handler(
      createArgs({ lines: [{ ...GOOD_LINE, gl_account_id: ACCOUNT }] }),
      ctx(),
    );
    expect(errText(r)).toContain('not GL accounts in your company');
    expect(createSupplierInvoice).not.toHaveBeenCalled();
    expect(vi.mocked(accountsBelongToCompany).mock.calls[0]![1]).toEqual([ACCOUNT]);
  });

  it('skips the account ownership query entirely when no line names an account', async () => {
    await createSupplierInvoiceTool.handler(createArgs(), ctx());
    expect(accountsBelongToCompany).not.toHaveBeenCalled();
  });

  it('names the offending line INDEX and refuses before any query', async () => {
    const cases: [unknown, RegExp][] = [
      [[GOOD_LINE, { ...GOOD_LINE, quantity: 0 }], /lines\[1\]\.quantity/],
      [[{ ...GOOD_LINE, unit_price: -1 }], /lines\[0\]\.unit_price/],
      [[{ ...GOOD_LINE, description: '  ' }], /lines\[0\]\.description/],
      [[GOOD_LINE, { ...GOOD_LINE, gl_account_id: 'nope' }], /invalid lines\[1\]\.gl_account_id/],
      [[{ ...GOOD_LINE, tax_rate: 250 }], /lines\[0\]\.tax_rate/],
      [[], /non-empty array/],
    ];
    for (const [lines, pattern] of cases) {
      vi.clearAllMocks();
      vi.mocked(supplierBelongsToCompany).mockResolvedValue(true);
      const r = await createSupplierInvoiceTool.handler(createArgs({ lines }), ctx());
      expect(errText(r)).toMatch(pattern);
      expect(supplierBelongsToCompany).not.toHaveBeenCalled();
      expect(createSupplierInvoice).not.toHaveBeenCalled();
    }
  });

  it('rejects a malformed date before it can reach a ::DATE cast', async () => {
    // Date.parse rolls 2026-02-31 forward to 3 March; Postgres throws 22008.
    const r = await createSupplierInvoiceTool.handler(
      createArgs({ invoice_date: '2026-02-31' }), ctx(),
    );
    expect(errText(r)).toBe('invalid invoice_date');
    expect(createSupplierInvoice).not.toHaveBeenCalled();
  });

  it('surfaces service validation but generic-ifies a pg error', async () => {
    vi.mocked(createSupplierInvoice).mockRejectedValueOnce(new Error('Line "x": quantity must be positive'));
    expect(errText(await createSupplierInvoiceTool.handler(createArgs(), ctx())))
      .toContain('quantity must be positive');

    vi.mocked(createSupplierInvoice).mockRejectedValueOnce(
      Object.assign(new Error('null value in column "duplicate_fingerprint"'), { code: '23502' }),
    );
    const generic = await createSupplierInvoiceTool.handler(createArgs(), ctx());
    expect(errText(generic)).toBe('Failed to create supplier invoice.');
    expect(errText(generic)).not.toContain('duplicate_fingerprint');
  });
});

describe('approve_supplier_invoice', () => {
  beforeEach(() => {
    vi.mocked(getSupplierInvoiceById).mockResolvedValue({ id: INVOICE, status: 'draft' } as never);
    vi.mocked(approveSupplierInvoice).mockResolvedValue({
      id: INVOICE, invoiceNumber: 'INV-9001', status: 'approved',
      totalAmount: 1150, glJournalEntryId: '88888888-8888-4888-8888-888888888888',
    } as never);
  });

  it('stamps the MCP posting agent so the entry shows in list_agent_postings', async () => {
    const r = parseOk(await approveSupplierInvoiceTool.handler({ invoice_id: INVOICE, ...KEY }, ctx()));
    expect(r.gl_journal_entry_id).toBe('88888888-8888-4888-8888-888888888888');
    expect(vi.mocked(approveSupplierInvoice).mock.calls[0]![3])
      .toEqual({ postingAgent: 'mcp:approve_supplier_invoice:v1', actorType: 'agent', actorTokenJti: 'jti' });
  });

  it('requires write:post — it posts an irreversible journal', () => {
    expect(approveSupplierInvoiceTool.requiresPost).toBe(true);
  });

  it('answers the status refusal from a READ, without calling the posting service', async () => {
    vi.mocked(getSupplierInvoiceById).mockResolvedValue({ id: INVOICE, status: 'paid' } as never);
    const r = await approveSupplierInvoiceTool.handler({ invoice_id: INVOICE, ...KEY }, ctx());
    expect(errText(r)).toBe('Cannot approve invoice with status: paid');
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  it('K-072 r30–r32: refuses a bill carrying a VAT its captured document never showed, without posting', async () => {
    vi.mocked(invoicesWithUnevidencedVat).mockResolvedValueOnce(new Set([INVOICE]));
    const r = await approveSupplierInvoiceTool.handler({ invoice_id: INVOICE, ...KEY }, ctx());
    expect(errText(r)).toBe('Cannot approve invoice: its VAT is not evidenced by its captured document.');
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  it('answers an unowned invoice with the generic miss text', async () => {
    vi.mocked(getSupplierInvoiceById).mockResolvedValue(null);
    const r = await approveSupplierInvoiceTool.handler({ invoice_id: INVOICE, ...KEY }, ctx());
    expect(errText(r)).toBe('Not found');
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  it('RETHROWS a posting failure so the savepoint unwinds a partial journal', async () => {
    vi.mocked(approveSupplierInvoice).mockRejectedValueOnce(
      new Error("System account with subtype 'payable' not found"),
    );
    await expect(approveSupplierInvoiceTool.handler({ invoice_id: INVOICE, ...KEY }, ctx()))
      .rejects.toThrow(/payable/);
  });
});
