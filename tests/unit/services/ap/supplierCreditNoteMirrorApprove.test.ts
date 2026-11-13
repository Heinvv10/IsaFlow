/**
 * Migration 988 + review round 1 (A3): approveCreditNote RE-RUNS the create planner for a mirror_bill note against
 * the bill as it stands (posted journals; other drafts do not block); a 'rate' note is not checked. `mirroredVatRefusals` is the same
 * judgement over a batch in the live posting order. Against a real ledger:
 * tests/integration/credit-note-mirror-bill-approve.int.test.ts and breaker5-mirror.int.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/reports/documentVatHistory', () => ({ getDocumentVatHistory: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNotePostingChecks', () => ({ lockInvoiceCreditNotes: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { getDocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import {
  MirroredNoteVatRefusal, assertMirroredNoteVatStands, judgeMirroredApproval, mirroredVatRefusals,
} from '@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import type { DocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';

function bill(derivable = 150, heuristic = 0, base = 1000, matchWritten = '2026-06-01T09:00:00.000Z'): DocumentVatHistory {
  const matches = heuristic ? [{ journal_entry_id: 'jm', entry_number: 'JE-9', tie: 'narration_match', source: 'manual', vat_amount: heuristic, last_written_at: matchWritten }] : [];
  return {
    document_number: 'SIV1', document_status: 'approved',
    lines: heuristic ? [{ journal_entry_id: 'jm', entry_number: 'JE-9', tie: 'narration_match', vat_amount: heuristic }] : [],
    totals: { vat_posted: 150, vat_derivable_now: derivable, vat_heuristic: heuristic, vat_heuristic_reducing: Math.min(0, heuristic),
      vat_net_now: derivable + Math.min(0, heuristic), net_base_posted: 1000, net_base_now: base },
    heuristic: { searched: true, truncated: false, limit: 100, matches },
  } as unknown as DocumentVatHistory;
}
const ACKED = [{ journal_entry_id: 'jm', vat_amount: -75 }];
const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1', number: 'CN-1', type: 'supplier', billId: 'b1', subtotal: 500, taxAmount: 75, vatBasis: 'mirror_bill',
  createdAt: '2026-06-01T10:00:00.000Z', ...over,
});

beforeEach(() => {
  vi.mocked(getDocumentVatHistory).mockReset();
  vi.mocked(sql).mockReset();
});

describe('judgeMirroredApproval', () => {
  it('passes a partial mirrored note on a clean bill', () => {
    expect(judgeMirroredApproval(bill(), note())).toBeNull();
  });

  it('REFUSES a partial note after a hand journal reversed some of the bill\'s VAT (breaker REPRO 3), naming it and the way on', () => {
    const why = judgeMirroredApproval(bill(150, -75), note())!;
    expect(why).toMatch(/^VAT_ALREADY_REVERSED: credit note CN-1 was raised with mirror_bill on bill SIV1, which has changed since/);
    expect(why).toContain('JE-9 narration_match');
    expect(why).toContain('Cancel this draft with cancel_credit_note');
    expect(why).toContain('acknowledge_vat_already_reversed: true');
    expect(why).toContain('a person must decide');
  });

  it('REFUSES a note whose tax exceeds what the bill now gives on its subtotal, by more than a cent', () => {
    expect(judgeMirroredApproval(bill(), note({ taxAmount: 75.01 }))).toBeNull();
    expect(judgeMirroredApproval(bill(), note({ taxAmount: 75.02 }))).toMatch(/It would reverse 75.02 of VAT; the bill now gives 75 on this subtotal/);
  });

  it('REFUSES when the bill\'s derivable VAT moved out of proportion since (a note at the wrong rate)', () => {
    expect(judgeMirroredApproval(bill(140, 0, 1000), note())).toMatch(/less than its posted rate gives/);
  });

  it('an acknowledged note is refused when a journal moving the bill\'s VAT was WRITTEN after it (review round 2, R2-3)', () => {
    const ack = note({ vatBasis: 'mirror_bill_ack', taxAmount: 0, ackMatches: ACKED });
    expect(judgeMirroredApproval(bill(150, -75, 1000, '2026-06-01T09:00:00.000Z'), ack)).toBeNull();
    expect(judgeMirroredApproval(bill(150, -75, 1000, '2026-06-01T11:00:00.000Z'), ack))
      .toMatch(/were written after the acknowledgement \(JE-9 \[manual\] narration_match -75\)/);
  });

  it('an acknowledged note is judged on its stated amount against the derivable VAT only', () => {
    expect(judgeMirroredApproval(bill(150, -75), note({ vatBasis: 'mirror_bill_ack', taxAmount: 0, ackMatches: ACKED }))).toBeNull();
    expect(judgeMirroredApproval(bill(150, -75), note({ vatBasis: 'mirror_bill_ack', taxAmount: 75.02, ackMatches: ACKED }))).toMatch(/more than the/);
  });

  it('an acknowledged note is refused when a VAT-moving match is not in the acknowledged set, or moves a different amount (R4-1)', () => {
    const ack = (ackMatches: unknown) => note({ vatBasis: 'mirror_bill_ack', taxAmount: 0, ackMatches });
    expect(judgeMirroredApproval(bill(150, -75), ack([]))).toMatch(/move its VAT differently from what was acknowledged \(JE-9 \[manual\]/);
    expect(judgeMirroredApproval(bill(150, -75), ack(null))).toMatch(/differently from what was acknowledged/);
    expect(judgeMirroredApproval(bill(150, -75), ack([{ journal_entry_id: 'jm', vat_amount: -70 }]))).toMatch(/differently from what was acknowledged/);
    expect(judgeMirroredApproval(bill(150, -75), ack(ACKED))).toBeNull();
  });

  it('an acknowledged note is refused when the heuristic search was truncated (round 5)', () => {
    const h = bill(150, -75);
    (h.heuristic as { truncated: boolean }).truncated = true;
    expect(judgeMirroredApproval(h, note({ vatBasis: 'mirror_bill_ack', taxAmount: 0, ackMatches: ACKED }))).toMatch(/More than 100 journals name the bill/);
  });

  it('other open drafts do NOT block this approval (the first approved wins)', () => {
    expect(judgeMirroredApproval(bill(), note({ subtotal: 600, taxAmount: 90 }))).toBeNull();
  });
});

describe('assertMirroredNoteVatStands', () => {
  it('reads the bill company-scoped and throws a coded refusal', async () => {
    vi.mocked(getDocumentVatHistory).mockResolvedValue(bill(150, -75));
    const err = await assertMirroredNoteVatStands('co', note()).catch((e: unknown) => e);
    expect(getDocumentVatHistory).toHaveBeenCalledWith('co', 'supplier_invoice', 'b1');
    expect(err).toBeInstanceOf(MirroredNoteVatRefusal);
    expect((err as MirroredNoteVatRefusal).code).toBe('VAT_ALREADY_REVERSED');
    expect(isRefusalCoded(err)).toBe(true);
  });

  it('does not check a note at its own rate, a customer note, or an unlinked note: unchanged', async () => {
    for (const n of [note({ vatBasis: 'rate' }), note({ type: 'customer' }), note({ billId: null })]) {
      await expect(assertMirroredNoteVatStands('co', n)).resolves.toBeUndefined();
    }
    expect(getDocumentVatHistory).not.toHaveBeenCalled();
  });
});

describe('mirroredVatRefusals — a batch in live order', () => {
  const row = (id: string, subtotal: number, tax: number, basis = 'mirror_bill') =>
    ({ id, credit_note_number: id.toUpperCase(), type: 'supplier', supplier_invoice_id: 'b1', subtotal: String(subtotal), tax_amount: String(tax), vat_basis: basis,
      created_at: new Date('2026-06-01T10:00:00Z') });

  it('each note that posts takes its base and VAT off the bill; a later mirrored note the bill cannot carry is refused', async () => {
    vi.mocked(getDocumentVatHistory).mockResolvedValue(bill(150, 0, 1000));
    vi.mocked(sql).mockResolvedValueOnce([row('m1', 500, 75), row('r1', 500, 75, 'rate'), row('m2', 500, 75)] as never);
    const r = await mirroredVatRefusals('co', ['m1', 'r1', 'm2']);
    expect([...r.keys()]).toEqual(['m2']);
    const q = (vi.mocked(sql).mock.calls[0]![0] as unknown as string[]).join('?');
    expect(q).toMatch(/company_id = \?::UUID/);
  });

  it('a refused note does not take VAT off the bill, so the next one may still post', async () => {
    vi.mocked(getDocumentVatHistory).mockResolvedValue(bill(150, 0, 1000));
    vi.mocked(sql).mockResolvedValueOnce([row('m1', 500, 100), row('m2', 500, 75)] as never);
    expect([...(await mirroredVatRefusals('co', ['m1', 'm2'])).keys()]).toEqual(['m1']);
  });

  it('reads no bill when the batch holds no mirrored note', async () => {
    vi.mocked(sql).mockResolvedValueOnce([row('r1', 500, 75, 'rate')] as never);
    expect((await mirroredVatRefusals('co', ['r1'])).size).toBe(0);
    expect(getDocumentVatHistory).not.toHaveBeenCalled();
  });
});
