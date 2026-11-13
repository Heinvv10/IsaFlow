/**
 * mirror_bill's plan (brief step 5b): a supplier note's VAT taken from the bill as it stands now, and the
 * refusal — unless acknowledged — when the bill's VAT was already reversed out of proportion to its base.
 */
import { describe, expect, it } from 'vitest';
import { planMirroredNote } from '@/modules/accounting/services/ap/supplierCreditNoteMirror';
import type { DocumentVatHistory, DocumentVatLine } from '@/modules/accounting/services/reports/documentVatHistory';

function history(totals: Partial<DocumentVatHistory['totals']>, lines: Partial<DocumentVatLine>[] = []): DocumentVatHistory {
  return {
    entity_type: 'supplier_invoice', entity_id: 'b', document_number: 'SIV3762', external_document_number: null,
    document_status: 'approved',
    lines: lines.map((l, i) => ({
      journal_entry_id: `je-${i}`, entry_number: `JE-${i}`, entry_date: '2026-06-01', source: 'manual', status: 'posted',
      reversed: false, reverses_journal_id: null, tie: 'posting', tied_via: null, matched_in: null, gl_account_id: 'a',
      account_code: '1140', account_name: 'VAT', vat_type: 'standard', vat_amount: 0, net_base: null, description: null, ...l,
    })),
    totals: {
      vat_posted: 260.87, vat_reversed: 0, vat_net_now: 260.87,
      vat_by_tie: { posting: 260.87, reversal: 0, credit_note: 0, reference_match: 0, narration_match: 0 },
      net_base_posted: 1739.13, net_base_now: 1739.13, ...totals,
    },
    heuristic: { tokens: ['SIV3762'], skipped_tokens: [], journals_matched: 0, truncated: false, limit: 100, note: '' },
  };
}

describe('planMirroredNote', () => {
  it('a clean bill: the note carries the bill\'s own rate; the whole remainder carries the whole VAT', () => {
    const part = planMirroredNote(history({}), 1000, false);
    expect(part).toMatchObject({ ok: true, plan: { taxAmount: 150, billVatRateNow: 15, vatOutOfProportion: 0 } });
    const whole = planMirroredNote(history({}), 1739.13, false);
    expect(whole).toMatchObject({ ok: true, plan: { taxAmount: 260.87 } });
  });

  it('a zero-rated bill mirrors 0% VAT, not the 15% default', () => {
    const r = planMirroredNote(history({ vat_posted: 0, vat_net_now: 0 }), 500, false);
    expect(r).toMatchObject({ ok: true, plan: { taxAmount: 0, taxRate: 0 } });
  });

  it('after an earlier note took half, the rate still stands and the remainder mirrors exactly', () => {
    const h = history({ vat_net_now: 130.44, vat_reversed: 130.43, net_base_now: 869.57 },
      [{ tie: 'credit_note', vat_amount: -130.43 }]);
    expect(planMirroredNote(h, 869.57, false)).toMatchObject({ ok: true, plan: { taxAmount: 130.44 } });
  });

  it('REFUSES when a journal already reversed the VAT (SIV3762 / JE-2026-26788), naming the journal', () => {
    const h = history({ vat_net_now: 0, vat_reversed: 260.87 },
      [{ tie: 'posting', vat_amount: 260.87 }, { tie: 'narration_match', vat_amount: -260.87, entry_number: 'JE-2026-26788' }]);
    const r = planMirroredNote(h, 1739.13, false);
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason).toMatch(/^VAT_ALREADY_REVERSED/);
    expect(reason).toContain('JE-2026-26788 narration_match R-260.87');
    expect(reason).toContain('acknowledge_vat_already_reversed');
    expect(reason).toContain('heuristic');
  });

  it('acknowledged: the note carries only the VAT the bill still carries (none here), never the second reversal', () => {
    const h = history({ vat_net_now: 0, vat_reversed: 260.87 }, [{ tie: 'narration_match', vat_amount: -260.87 }]);
    expect(planMirroredNote(h, 1739.13, true)).toMatchObject({ ok: true, acknowledged: true, plan: { taxAmount: 0, vatOutOfProportion: 260.87 } });
  });

  it('a partial manual reversal is refused too, and acknowledged mirrors the remaining rate', () => {
    const h = history({ vat_net_now: 160.87, vat_reversed: 100 }, [{ tie: 'reference_match', vat_amount: -100 }]);
    expect(planMirroredNote(h, 1739.13, false).ok).toBe(false);
    expect(planMirroredNote(h, 1739.13, true)).toMatchObject({ ok: true, plan: { taxAmount: 160.87 } });
    // Part of the bill: the rate AS IT STANDS (160.87 / 1739.13 = 9.25%), not the 15% it was posted at.
    expect(planMirroredNote(h, 1000, true)).toMatchObject({ ok: true, plan: { taxAmount: 92.5, billVatRateNow: 9.25 } });
  });

  it('refuses a bill with no posted base, one already fully credited, and a subtotal above what is left', () => {
    expect(planMirroredNote(history({ net_base_posted: 0, net_base_now: 0, vat_posted: 0, vat_net_now: 0 }), 10, false))
      .toMatchObject({ ok: false, reason: expect.stringContaining('no posted journal') });
    expect(planMirroredNote(history({ net_base_now: 0, vat_net_now: 0 }), 10, false))
      .toMatchObject({ ok: false, reason: expect.stringContaining('nothing to mirror') });
    expect(planMirroredNote(history({}), 1739.14, false))
      .toMatchObject({ ok: false, reason: expect.stringContaining('more than the R1739.13') });
  });

  it('rounding of several earlier notes stays inside the tolerance', () => {
    const h = history({ vat_net_now: 86.94, net_base_now: 579.71 },
      [{ tie: 'credit_note', vat_amount: -86.96 }, { tie: 'credit_note', vat_amount: -86.97 }]);
    expect(planMirroredNote(h, 579.71, false)).toMatchObject({ ok: true, plan: { taxAmount: 86.94 } });
  });
});
