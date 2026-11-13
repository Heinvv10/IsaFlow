/**
 * Migration 988: approveCreditNote re-checks a mirror_bill supplier note against the VAT its bill still
 * carries; a note at its own rate is not checked. `mirroredVatRefusals` is the same rule over a batch in
 * the live posting order (bulk_approve_credit_notes, dry run and live alike). Against a real ledger:
 * tests/integration/credit-note-mirror-bill-approve.int.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/reports/documentVatHistory', () => ({ getDocumentVatHistory: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { getDocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import {
  MirroredNoteVatRefusal, assertMirroredNoteVatStands, mirroredVatRefusals,
} from '@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';

const standing = (vat: number) => vi.mocked(getDocumentVatHistory).mockResolvedValue(
  { document_number: 'SIV1', totals: { vat_net_now: vat } } as never);
const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1', number: 'CN-1', type: 'supplier', billId: 'b1', taxAmount: 75, vatBasis: 'mirror_bill', ...over,
});

beforeEach(() => {
  vi.mocked(getDocumentVatHistory).mockReset();
  vi.mocked(sql).mockReset();
});

describe('assertMirroredNoteVatStands', () => {
  it('passes a mirrored note the bill still carries (cent tolerance) and reads the bill company-scoped', async () => {
    standing(74.99);
    await expect(assertMirroredNoteVatStands('co', note())).resolves.toBeUndefined();
    expect(getDocumentVatHistory).toHaveBeenCalledWith('co', 'supplier_invoice', 'b1');
    standing(74.98);
    await expect(assertMirroredNoteVatStands('co', note())).rejects.toBeInstanceOf(MirroredNoteVatRefusal);
  });

  it('refuses a mirrored note above what the bill still carries, with a refusal code the MCP and REST layers surface', async () => {
    standing(0);
    const err = await assertMirroredNoteVatStands('co', note()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MirroredNoteVatRefusal);
    expect((err as MirroredNoteVatRefusal).code).toBe('VAT_ALREADY_REVERSED');
    expect((err as Error).message).toMatch(/^VAT_ALREADY_REVERSED: credit note CN-1 was raised with mirror_bill/);
    expect(isRefusalCoded(err)).toBe(true);
  });

  it('does not check a note at its own rate, a customer note, or an unlinked note: unchanged', async () => {
    standing(0);
    for (const n of [note({ vatBasis: 'rate' }), note({ type: 'customer' }), note({ billId: null })]) {
      await expect(assertMirroredNoteVatStands('co', n)).resolves.toBeUndefined();
    }
    expect(getDocumentVatHistory).not.toHaveBeenCalled();
  });
});

describe('mirroredVatRefusals — a batch in live order', () => {
  const row = (id: string, tax: number, basis = 'mirror_bill', bill = 'b1') =>
    ({ id, credit_note_number: id.toUpperCase(), type: 'supplier', supplier_invoice_id: bill, tax_amount: String(tax), vat_basis: basis });

  it('each note that posts takes its VAT off the bill; a later mirrored note the bill cannot carry is refused', async () => {
    standing(150);
    vi.mocked(sql).mockResolvedValue([row('m1', 75), row('r1', 75, 'rate'), row('m2', 75)] as never);
    const r = await mirroredVatRefusals('co', ['m1', 'r1', 'm2']);
    expect([...r.keys()]).toEqual(['m2']);
    expect(r.get('m2')).toContain('bill SIV1 now carries only');
    const q = (vi.mocked(sql).mock.calls[0]![0] as unknown as string[]).join('?');
    expect(q).toMatch(/company_id = \?::UUID/);
  });

  it('a refused note does not take VAT off the bill, so the next one may still post', async () => {
    standing(80);
    vi.mocked(sql).mockResolvedValue([row('m1', 100), row('m2', 75)] as never);
    expect([...(await mirroredVatRefusals('co', ['m1', 'm2'])).keys()]).toEqual(['m1']);
  });

  it('reads no bill when the batch holds no mirrored note', async () => {
    vi.mocked(sql).mockResolvedValue([row('r1', 75, 'rate')] as never);
    expect((await mirroredVatRefusals('co', ['r1'])).size).toBe(0);
    expect(getDocumentVatHistory).not.toHaveBeenCalled();
  });
});
