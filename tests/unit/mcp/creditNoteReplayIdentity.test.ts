/**
 * create_credit_note's external_ref replay (#1701 round 9, the gate's major): a replay is the SAME note only when the
 * party (client_id / supplier_id) and the linked document (customer_invoice_id / supplier_invoice_id) match too. A
 * reused external_ref naming another invoice or customer is REFUSED, naming the field, nothing written and the old note
 * not returned as a success. Date / subtotal / total differences keep their payload_differs reply.
 */
import { describe, it, expect, vi } from 'vitest';
import { CUSTOMER, CUST_INV, KEY, ctx, parseOk, errText } from './creditNoteTools.harness';

vi.mock('@/modules/accounting/services/core/externalRefService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/core/externalRefService')>()),
  findByExternalRef: vi.fn(async () => []),
  lockExternalRef: vi.fn(async () => undefined),
  stampExternalRef: vi.fn(async () => undefined),
}));

import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { findByExternalRef } from '@/modules/accounting/services/core/externalRefService';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';

const OTHER_INV = '77777777-7777-4777-8777-777777777777';
const OTHER_CUSTOMER = '88888888-8888-4888-8888-888888888888';
const XREF = { external_system: 'sage', external_ref: 'CRET-1' };
// A linked customer note with no VAT figure or rate: the replay compares no total (its VAT is the invoice's remainder).
const args = { type: 'customer', client_id: CUSTOMER, customer_invoice_id: CUST_INV, credit_date: '2026-11-11', subtotal: 100, ...KEY, ...XREF };
const stored = (identity: Record<string, string | null>) => [{
  entityType: 'credit_note' as const, id: 'cn-1', number: 'CN-1', status: 'approved', date: '2026-11-11', totalAmount: 115, subtotal: 100,
  live: true, externalDocumentNumber: null, creditNoteType: 'customer',
  identity: { client_id: CUSTOMER, supplier_id: null, customer_invoice_id: CUST_INV, supplier_invoice_id: null, ...identity },
}];

describe('create_credit_note replay: the party and the linked document', () => {
  it('the same ref for a DIFFERENT invoice is refused, naming customer_invoice_id; nothing written, the old note not returned', async () => {
    vi.mocked(findByExternalRef).mockResolvedValueOnce(stored({ customer_invoice_id: OTHER_INV }));
    const r = await createCreditNoteTool.handler(args, ctx());
    expect(r.isError).toBe(true);
    expect(r.wroteNothing).toBe(true);
    expect(errText(r)).toMatch(/^external_ref CRET-1 \(sage\) is already used by credit note CN-1 for a different customer_invoice_id/);
    expect(errText(r)).not.toMatch(/already_existed/);
    expect(createCreditNote).not.toHaveBeenCalled();
  });
  it('the same ref for a DIFFERENT customer is refused, naming client_id', async () => {
    vi.mocked(findByExternalRef).mockResolvedValueOnce(stored({ client_id: OTHER_CUSTOMER }));
    const r = await createCreditNoteTool.handler(args, ctx());
    expect(r.isError).toBe(true);
    expect(errText(r)).toMatch(/for a different client_id/);
  });
  it('a stored note linked nowhere and a request naming an invoice: refused (the link is part of the note)', async () => {
    vi.mocked(findByExternalRef).mockResolvedValueOnce(stored({ customer_invoice_id: null }));
    expect(errText(await createCreditNoteTool.handler(args, ctx()))).toMatch(/for a different customer_invoice_id/);
  });
  it('the same ref, customer and invoice is still a clean replay (no total compared: the VAT moved at approval)', async () => {
    vi.mocked(findByExternalRef).mockResolvedValueOnce(stored({ customer_invoice_id: CUST_INV.toUpperCase() }));
    const out = parseOk(await createCreditNoteTool.handler(args, ctx()));
    expect(out).toMatchObject({ already_existed: true, payload_differs: false, id: 'cn-1' });
  });
});
