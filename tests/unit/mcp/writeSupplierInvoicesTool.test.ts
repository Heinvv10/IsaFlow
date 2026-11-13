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

// The supplier's default CC/BU (migration 890) are read from the database; this file does not, so the supplier
// has none. Their effect on the cost-of-sales check is pinned by tests/integration/supplier-default-dimensions-checks.int.test.ts.
vi.mock('@/modules/accounting/services/gl/dimensions/supplierDimensionDefaults', () => ({
  loadSupplierDefaultDimensions: vi.fn(async () => ({})),
  applySupplierDefaultDimensions: vi.fn((lines: unknown[]) => [...lines]),
}));
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
// R-035: the approval gate has its own integration suite (r035-pr2-unattended);
// here no enforced rule governs any bill.
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ agentApprovalRefusal: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/capture/capturedVatEvidence', () => ({
  invoiceVatRefusals: vi.fn(async () => new Map<string, string>()),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  supplierBelongsToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/billLineAccountGuard', () => ({
  billLineAccountRefusal: vi.fn(),
}));
// Supplier terms for the due-date warning: none set unless a test says otherwise (dueDateTermsWarning.test.ts has the rest).
vi.mock('@/modules/accounting/services/core/paymentTermsResolver', () => ({
  contactTerms: vi.fn(async () => ({ days: null, type: null, companyDefault: { days: 30, type: 'invoice_days' } })),
}));

vi.mock('@/modules/accounting/services/core/externalRefService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/core/externalRefService')>()),
  findByExternalRef: vi.fn(async () => []),
  lockExternalRef: vi.fn(async () => undefined),
  stampExternalRef: vi.fn(async () => undefined),
}));

import {
  createSupplierInvoice,
  getSupplierInvoiceById,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { invoiceVatRefusals } from '@/modules/accounting/services/capture/capturedVatEvidence';
import { billLineAccountRefusal } from '@/modules/accounting/services/ap/billLineAccountGuard';
import { contactTerms } from '@/modules/accounting/services/core/paymentTermsResolver';
import {
  createSupplierInvoiceTool,
  approveSupplierInvoiceTool,
} from '@/lib/mcp/tools/writeSupplierInvoices';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';
import { findByExternalRef, stampExternalRef } from '@/modules/accounting/services/core/externalRefService';

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
  vi.mocked(billLineAccountRefusal).mockResolvedValue(null);
  vi.mocked(createSupplierInvoice).mockResolvedValue({
    id: INVOICE, invoiceNumber: 'INV-9001', supplierId: SUPPLIER,
    invoiceDate: '2026-06-30', subtotal: 1000, taxAmount: 150,
    totalAmount: 1150, status: 'draft',
  } as never);
});

describe('create_supplier_invoice — external_ref (brief step 3)', () => {
  const XREF = { external_system: 'sage', external_ref: '3629825983', external_document_number: 'SIV0003762' };

  it('returns the live bill already carrying the reference and creates nothing', async () => {
    vi.mocked(findByExternalRef).mockResolvedValueOnce([{
      entityType: 'supplier_invoice', id: 'existing', number: 'INV-9001', status: 'approved', date: '2026-06-30',
      totalAmount: 1150, live: true, externalDocumentNumber: 'SIV0003762',
    }]);
    const r = await createSupplierInvoiceTool.handler(createArgs(XREF), ctx());
    expect(r.wroteNothing).toBe(true);
    expect(parseOk(r)).toMatchObject({ already_existed: true, id: 'existing' });
    expect(createSupplierInvoice).not.toHaveBeenCalled();
    expect(stampExternalRef).not.toHaveBeenCalled();
  });

  it('creates the bill with the reference in its own INSERT (migration 986 uniqueness sees it), no stamp after', async () => {
    const r = parseOk(await createSupplierInvoiceTool.handler(createArgs(XREF), ctx()));
    expect(vi.mocked(createSupplierInvoice).mock.calls[0]![1]).toMatchObject({
      externalRef: { system: 'sage', ref: '3629825983', documentNumber: 'SIV0003762' },
    });
    expect(stampExternalRef).not.toHaveBeenCalled();
    expect(r).toMatchObject({ id: INVOICE, external_system: 'sage', external_ref: '3629825983' });
  });

  it('refuses a reference with no system before any read', async () => {
    expect(errText(await createSupplierInvoiceTool.handler(createArgs({ external_ref: '1' }), ctx()))).toMatch(/external_system/);
    expect(findByExternalRef).not.toHaveBeenCalled();
  });

  it('without a reference, never touches the reference service', async () => {
    parseOk(await createSupplierInvoiceTool.handler(createArgs(), ctx()));
    expect(vi.mocked(createSupplierInvoice).mock.calls[0]![1]).not.toHaveProperty('externalRef');
    expect(findByExternalRef).not.toHaveBeenCalled();
    expect(stampExternalRef).not.toHaveBeenCalled();
  });
});

describe('create_supplier_invoice', () => {
  it('keeps a given due_date that differs from the supplier terms, and says so in due_date_warnings', async () => {
    vi.mocked(contactTerms).mockResolvedValueOnce({ days: 3, type: 'statement_months', companyDefault: { days: 30, type: 'invoice_days' } });
    const r = parseOk(await createSupplierInvoiceTool.handler(
      createArgs({ invoice_date: '2026-11-09', due_date: '2027-02-07' }), ctx(),
    ));
    expect((vi.mocked(createSupplierInvoice).mock.calls[0]![1] as { dueDate?: string }).dueDate).toBe('2027-02-07');
    const w = r.due_date_warnings as string[];
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('2027-02-28');
  });

  it('has no due_date_warnings when the bill\'s own payment_terms give the date', async () => {
    vi.mocked(contactTerms).mockResolvedValueOnce({ days: 3, type: 'statement_months', companyDefault: { days: 30, type: 'invoice_days' } });
    const r = parseOk(await createSupplierInvoiceTool.handler(
      createArgs({ invoice_date: '2026-11-09', due_date: '2027-01-08', payment_terms: 'net60' }), ctx(),
    ));
    expect(r.due_date_warnings).toBeUndefined();
  });

  it('has no due_date_warnings when no due_date is given', async () => {
    const r = parseOk(await createSupplierInvoiceTool.handler(createArgs(), ctx()));
    expect(r.due_date_warnings).toBeUndefined();
  });

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
    vi.mocked(billLineAccountRefusal).mockResolvedValue('One or more lines[].gl_account_id values are not GL accounts in your company.');
    const r = await createSupplierInvoiceTool.handler(
      createArgs({ lines: [{ ...GOOD_LINE, gl_account_id: ACCOUNT }] }),
      ctx(),
    );
    expect(errText(r)).toContain('not GL accounts in your company');
    expect(createSupplierInvoice).not.toHaveBeenCalled();
    expect(vi.mocked(billLineAccountRefusal).mock.calls[0]![1]).toEqual([ACCOUNT]);
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
    vi.mocked(createSupplierInvoice).mockRejectedValueOnce(new Error('Line 1: quantity must be positive'));
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
      .toEqual({
        postingAgent: 'mcp:approve_supplier_invoice:v1', actorType: 'agent', actorTokenJti: 'jti',
        allowLateInputClaim: false, // no allow_late_input_claim argument: no late claim
        // P5-2: an agent's approval is checked on the mcp channel, never overridden; no figures without read:reports (S1).
        budget: { channel: 'mcp', lock: 'take', figures: false },
      });
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
    vi.mocked(invoiceVatRefusals).mockResolvedValueOnce(new Map([[INVOICE, 'its VAT is not evidenced by its captured document']]));
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
