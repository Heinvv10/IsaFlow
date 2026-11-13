/**
 * create_credit_note mirror_bill (brief step 5b): argument refusals before any read or write, the
 * VAT_ALREADY_REVERSED refusal from the plan, and the mirrored VAT reaching the service and the dedupe.
 * The plan's arithmetic: tests/unit/services/ap/supplierCreditNoteMirror.test.ts; against a real ledger:
 * tests/integration/credit-note-mirror-bill.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/ap/supplierCreditNoteMirror', () => ({ planMirroredSupplierNote: vi.fn() }));

import { COMPANY, SUPPLIER, SUPP_INV, CUSTOMER, KEY, ctx, parseOk, errText, draftNote } from './creditNoteTools.harness';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { findOpenDuplicateDraft } from '@/modules/accounting/services/ar/creditNoteLinkService';
import { planMirroredSupplierNote, type MirrorPlan } from '@/modules/accounting/services/ap/supplierCreditNoteMirror';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';

const base = { type: 'supplier', supplier_id: SUPPLIER, supplier_invoice_id: SUPP_INV, credit_date: '2026-06-30', subtotal: 1000, ...KEY };
const plan: MirrorPlan = {
  taxAmount: 0, taxRate: 0, billVatRateNow: 0, vatNetNow: 0, netBaseNow: 1739.13, vatOutOfProportion: 260.87,
  adjustingJournals: [{ entry_number: 'JE-2026-26788', tie: 'narration_match', vat_amount: -260.87 }],
};

beforeEach(() => {
  vi.mocked(planMirroredSupplierNote).mockReset();
  vi.mocked(createCreditNote).mockResolvedValue({ ...draftNote, type: 'supplier', taxAmount: 0, totalAmount: 1000 } as never);
});

describe('create_credit_note mirror_bill — argument refusals, before any read or write', () => {
  it.each([
    [{ ...base, type: 'customer', client_id: CUSTOMER, supplier_id: undefined, supplier_invoice_id: undefined, mirror_bill: true }, 'supplier credit notes only'],
    [{ ...base, supplier_invoice_id: undefined, mirror_bill: true }, 'needs supplier_invoice_id'],
    [{ ...base, mirror_bill: true, tax_rate: 15 }, 'leave tax_rate out'],
    [{ ...base, acknowledge_vat_already_reversed: true }, 'only applies with mirror_bill'],
    [{ ...base, mirror_bill: 'yes' }, 'mirror_bill must be true or false'],
  ])('%#: refuses', async (args, message) => {
    expect(errText(await createCreditNoteTool.handler(args, ctx()))).toContain(message);
    expect(planMirroredSupplierNote).not.toHaveBeenCalled();
    expect(createCreditNote).not.toHaveBeenCalled();
  });
});

describe('create_credit_note mirror_bill — the plan', () => {
  it('a refused plan (VAT already reversed) is a tool error and nothing is written', async () => {
    vi.mocked(planMirroredSupplierNote).mockResolvedValue({ ok: false, reason: 'VAT_ALREADY_REVERSED: bill SIV3762 …' });
    const r = await createCreditNoteTool.handler({ ...base, mirror_bill: true }, ctx());
    expect(errText(r)).toMatch(/^VAT_ALREADY_REVERSED/);
    expect(planMirroredSupplierNote).toHaveBeenCalledWith(COMPANY, SUPP_INV, 1000, false);
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('acknowledged: the plan\'s VAT reaches the service and the dedupe, and the reply says so', async () => {
    vi.mocked(planMirroredSupplierNote).mockResolvedValue({ ok: true, plan, acknowledged: true });
    const r = parseOk(await createCreditNoteTool.handler({ ...base, mirror_bill: true, acknowledge_vat_already_reversed: true }, ctx()));
    expect(planMirroredSupplierNote).toHaveBeenCalledWith(COMPANY, SUPP_INV, 1000, true);
    expect(createCreditNote).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ taxRate: 0, taxAmount: 0, subtotal: 1000 }),
      expect.any(String), expect.anything());
    expect(vi.mocked(findOpenDuplicateDraft).mock.calls[0]![2]).toBe(1000);
    expect(r.mirror).toMatchObject({ acknowledged_vat_already_reversed: true, vat_out_of_proportion: 260.87 });
  });

  it('a clean bill: the bill\'s rate, not the 15% default, sets tax and total', async () => {
    vi.mocked(planMirroredSupplierNote).mockResolvedValue({ ok: true, acknowledged: false,
      plan: { ...plan, taxAmount: 50, taxRate: 5, billVatRateNow: 5, vatOutOfProportion: 0, adjustingJournals: [] } });
    await createCreditNoteTool.handler({ ...base, mirror_bill: true }, ctx());
    expect(createCreditNote).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ taxRate: 5, taxAmount: 50 }),
      expect.any(String), expect.anything());
    expect(vi.mocked(findOpenDuplicateDraft).mock.calls[0]![2]).toBe(1050);
  });

  it('without mirror_bill nothing changes: no plan read, no taxAmount, the 15% default', async () => {
    await createCreditNoteTool.handler(base, ctx());
    expect(planMirroredSupplierNote).not.toHaveBeenCalled();
    const input = vi.mocked(createCreditNote).mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(input).not.toHaveProperty('taxAmount');
    expect(input.taxRate).toBeUndefined();
    expect(vi.mocked(findOpenDuplicateDraft).mock.calls[0]![2]).toBe(1150);
  });

  it('the schema advertises both arguments', () => {
    const props = (createCreditNoteTool.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty('mirror_bill');
    expect(props).toHaveProperty('acknowledge_vat_already_reversed');
  });
});
