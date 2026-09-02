/**
 * list_credit_notes / get_credit_note / create_credit_note /
 * approve_credit_note / cancel_credit_note.
 *
 * What is worth pinning:
 *
 *  - create answers tenant AND counterparty ownership BEFORE the first write.
 *    Every id it accepts is a bare foreign key with no (id, company_id)
 *    constraint, and `approveCreditNote` AUTO-APPLIES a linked note — so a note
 *    naming customer A but linked to customer B's invoice would pay down B's
 *    debt with A's credit, silently and permanently.
 *  - cross-type argument combinations refuse rather than being written as
 *    NULLs, which would create a note that approves into a journal with
 *    nothing to apply against.
 *  - a non-positive subtotal refuses: it inverts the note's GL at approve,
 *    turning a credit note into an invoice wearing the wrong document type.
 *  - approve/cancel stamp `mcp:<tool>:v1`. Without it createJournalEntry falls
 *    back to defaultHumanMeta(userId), labelling agent work as the token
 *    owner's own and hiding it from list_agent_postings.
 *  - approve/cancel answer their status refusals from a READ and RETHROW
 *    everything else: a refusal is audited with a NULL idempotency key, so a
 *    catch-and-return after the journal posted would let the agent's retry post
 *    the note a second time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({
  getCreditNotes: vi.fn(),
  getCreditNoteById: vi.fn(),
  createCreditNote: vi.fn(),
  approveCreditNote: vi.fn(),
  cancelCreditNote: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteLinkService', () => ({
  validateCreditNoteLinks: vi.fn(),
}));

import {
  getCreditNotes,
  getCreditNoteById,
  createCreditNote,
  approveCreditNote,
  cancelCreditNote,
} from '@/modules/accounting/services/ar/creditNoteService';
import { validateCreditNoteLinks } from '@/modules/accounting/services/ar/creditNoteLinkService';
import { listCreditNotesTool, getCreditNoteTool } from '@/lib/mcp/tools/creditNotes';
import {
  createCreditNoteTool,
  approveCreditNoteTool,
  cancelCreditNoteTool,
} from '@/lib/mcp/tools/writeCreditNotes';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const SUPPLIER = '33333333-3333-4333-8333-333333333333';
const CUST_INV = '44444444-4444-4444-8444-444444444444';
const SUPP_INV = '55555555-5555-4555-8555-555555555555';
const NOTE = '66666666-6666-4666-8666-666666666666';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '99999999-9999-4999-8999-999999999999',
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

const draftNote = {
  id: NOTE,
  creditNoteNumber: 'CN-2026-00001',
  type: 'customer' as const,
  status: 'draft' as const,
  subtotal: 100,
  taxRate: 15,
  taxAmount: 15,
  totalAmount: 115,
  creditDate: '2026-06-30',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateCreditNoteLinks).mockResolvedValue(null);
});

describe('create_credit_note — pre-write guards', () => {
  const base = { type: 'customer', credit_date: '2026-06-30', subtotal: 100, ...KEY };

  it('refuses a non-positive subtotal before any ownership read or write', async () => {
    for (const subtotal of [0, -100]) {
      const r = await createCreditNoteTool.handler({ ...base, subtotal, client_id: CUSTOMER }, ctx());
      expect(errText(r)).toContain('subtotal must be a positive number');
    }
    expect(validateCreditNoteLinks).not.toHaveBeenCalled();
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('refuses cross-type arguments rather than writing them as NULLs', async () => {
    const cust = await createCreditNoteTool.handler(
      { ...base, client_id: CUSTOMER, supplier_invoice_id: SUPP_INV }, ctx(),
    );
    expect(errText(cust)).toContain('customer credit note cannot carry');

    const supp = await createCreditNoteTool.handler(
      { ...base, type: 'supplier', supplier_id: SUPPLIER, customer_invoice_id: CUST_INV }, ctx(),
    );
    expect(errText(supp)).toContain('supplier credit note cannot carry');

    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('refuses a tax_rate outside 0..100', async () => {
    const r = await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER, tax_rate: 150 }, ctx());
    expect(errText(r)).toContain('tax_rate must be between 0 and 100');
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('surfaces the link refusal and never writes — a foreign or mismatched id', async () => {
    vi.mocked(validateCreditNoteLinks).mockResolvedValue(
      'customer_invoice_id belongs to a different customer than client_id',
    );
    const r = await createCreditNoteTool.handler(
      { ...base, client_id: CUSTOMER, customer_invoice_id: CUST_INV }, ctx(),
    );
    expect(errText(r)).toContain('different customer');
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('validates links BEFORE calling the service, not after', async () => {
    const order: string[] = [];
    vi.mocked(validateCreditNoteLinks).mockImplementation(async () => {
      order.push('validate');
      return null;
    });
    vi.mocked(createCreditNote).mockImplementation(async () => {
      order.push('create');
      return draftNote as never;
    });
    await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER }, ctx());
    expect(order).toEqual(['validate', 'create']);
  });

  it('passes a supplier UUID straight through — never coerced to a number', async () => {
    vi.mocked(createCreditNote).mockResolvedValue({ ...draftNote, type: 'supplier' } as never);
    await createCreditNoteTool.handler(
      { type: 'supplier', credit_date: '2026-06-30', subtotal: 100, supplier_id: SUPPLIER, ...KEY },
      ctx(),
    );
    expect(createCreditNote).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ type: 'supplier', supplierId: SUPPLIER }),
      expect.any(String),
    );
  });

  it('creates a draft and reports the computed VAT totals', async () => {
    vi.mocked(createCreditNote).mockResolvedValue(draftNote as never);
    const out = parseOk(
      await createCreditNoteTool.handler({ ...base, client_id: CUSTOMER }, ctx()),
    );
    expect(out).toMatchObject({ status: 'draft', subtotal: 100, tax_amount: 15, total_amount: 115 });
  });
});

describe('approve_credit_note', () => {
  it('refuses a non-draft note from a READ, without calling the service', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue({ ...draftNote, status: 'applied' } as never);
    const r = await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx());
    expect(errText(r)).toContain('status: applied');
    expect(approveCreditNote).not.toHaveBeenCalled();
  });

  it('answers a missing note with the generic miss text', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(null as never);
    const r = await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx());
    expect(errText(r)).toBe('Not found');
  });

  it('stamps mcp:approve_credit_note:v1 so the posting shows in list_agent_postings', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);
    vi.mocked(approveCreditNote).mockResolvedValue({
      ...draftNote, status: 'approved', glJournalEntryId: 'je-1',
    } as never);

    await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx());
    expect(approveCreditNote).toHaveBeenCalledWith(
      COMPANY, NOTE, expect.any(String),
      { postingAgent: 'mcp:approve_credit_note:v1' },
    );
  });

  it('reports applied_to_invoice_id when the auto-apply fired, and null when it did not', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);

    vi.mocked(approveCreditNote).mockResolvedValue({
      ...draftNote, status: 'applied', customerInvoiceId: CUST_INV, glJournalEntryId: 'je-1',
    } as never);
    expect(parseOk(await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx())))
      .toMatchObject({ status: 'applied', applied_to_invoice_id: CUST_INV });

    vi.mocked(approveCreditNote).mockResolvedValue({
      ...draftNote, status: 'approved', glJournalEntryId: 'je-1',
    } as never);
    expect(parseOk(await approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx())))
      .toMatchObject({ status: 'approved', applied_to_invoice_id: null });
  });

  it('RETHROWS a service failure instead of flattening it into a tool error', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);
    vi.mocked(approveCreditNote).mockRejectedValue(new Error('no vat_output account'));
    await expect(approveCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx()))
      .rejects.toThrow('no vat_output account');
  });
});

describe('cancel_credit_note', () => {
  it('refuses a draft — there is no journal to reverse', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);
    const r = await cancelCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx());
    expect(errText(r)).toContain('status: draft');
    expect(cancelCreditNote).not.toHaveBeenCalled();
  });

  it('accepts both approved and applied, stamping the reversal', async () => {
    for (const status of ['approved', 'applied'] as const) {
      vi.clearAllMocks();
      vi.mocked(getCreditNoteById).mockResolvedValue({ ...draftNote, status } as never);
      vi.mocked(cancelCreditNote).mockResolvedValue({ ...draftNote, status: 'cancelled' } as never);

      const out = parseOk(
        await cancelCreditNoteTool.handler({ credit_note_id: NOTE, reason: 'duplicate', ...KEY }, ctx()),
      );
      expect(out.status).toBe('cancelled');
      expect(cancelCreditNote).toHaveBeenCalledWith(
        COMPANY, NOTE, expect.any(String), 'duplicate',
        { postingAgent: 'mcp:cancel_credit_note:v1' },
      );
    }
  });
});

describe('read tools', () => {
  it('list_credit_notes rejects an unknown type or status before querying', async () => {
    expect(errText(await listCreditNotesTool.handler({ type: 'vendor' }, ctx()))).toContain('type must be');
    expect(errText(await listCreditNotesTool.handler({ status: 'posted' }, ctx()))).toContain('status must be');
    expect(getCreditNotes).not.toHaveBeenCalled();
  });

  it('list_credit_notes clamps limit to 200 and passes the filters through', async () => {
    vi.mocked(getCreditNotes).mockResolvedValue({ creditNotes: [], total: 0 } as never);
    await listCreditNotesTool.handler({ type: 'supplier', status: 'applied', limit: 5000 }, ctx());
    expect(getCreditNotes).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ type: 'supplier', status: 'applied', limit: 200 }),
    );
  });

  it('get_credit_note answers a miss generically — never an existence oracle', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(null as never);
    expect(errText(await getCreditNoteTool.handler({ credit_note_id: NOTE }, ctx()))).toBe('Not found');
  });

  it('compacts a note to the actionable fields, including the ledger proof', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue({
      ...draftNote, status: 'applied', customerInvoiceId: CUST_INV, glJournalEntryId: 'je-1',
    } as never);
    const out = parseOk(await getCreditNoteTool.handler({ credit_note_id: NOTE }, ctx()));
    expect(out).toMatchObject({
      id: NOTE, type: 'customer', status: 'applied',
      customer_invoice_id: CUST_INV, gl_journal_entry_id: 'je-1', total_amount: 115,
    });
  });
});
