/**
 * mirror_bill's plan (brief step 5b; review round 1): a supplier note's VAT from the bill's DERIVABLE ties as they
 * stand, other open drafts netted off; refused — unless acknowledged with an explicit vat_amount — when the
 * derivable VAT is out of proportion, a heuristic match moved the bill's VAT, or the search was truncated. A
 * heuristic never writes.
 */
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/money/formatMoney';
import { NO_ACK, planMirroredNote } from '@/modules/accounting/services/ap/supplierCreditNoteMirror';
import type { DocumentVatHistory, DocumentVatLine } from '@/modules/accounting/services/reports/documentVatHistory';

const ack = (vatAmount: number | null) => ({ acknowledged: true, vatAmount });

function history(
  totals: Partial<DocumentVatHistory['totals']>, lines: Partial<DocumentVatLine>[] = [], truncated = false,
): DocumentVatHistory {
  const t = { vat_posted: 260.87, vat_derivable_now: 260.87, vat_heuristic: 0, net_base_posted: 1739.13, net_base_now: 1739.13, ...totals };
  const matches = lines.filter((l) => l.tie === 'narration_match' || l.tie === 'reference_match').map((l, i) => ({
    journal_entry_id: `m-${i}`, entry_number: l.entry_number ?? `JE-m${i}`, tie: l.tie!, vat_amount: l.vat_amount ?? 0,
    last_created_at: '2026-06-01T10:00:00.000Z',
  }));
  const reducing = matches.reduce((s, m) => s + Math.min(0, m.vat_amount), 0);
  return {
    entity_type: 'supplier_invoice', entity_id: 'b', document_number: 'SIV3762', external_document_number: null,
    document_status: 'approved',
    lines: lines.map((l, i) => ({
      journal_entry_id: `je-${i}`, entry_number: `JE-${i}`, entry_date: '2026-06-01', source: 'manual', status: 'posted',
      reversed: false, reverses_journal_id: null, tie: 'posting', tied_via: null, matched_in: null, gl_account_id: 'a',
      account_code: '1140', account_name: 'VAT', vat_type: 'standard', vat_amount: 0, net_base: null, description: null, ...l,
    })),
    totals: {
      ...t, vat_heuristic_reducing: reducing, vat_net_now: t.vat_derivable_now + reducing, vat_reversed: 0,
      vat_by_tie: { posting: t.vat_posted, late_claim: 0, reversal: 0, credit_note: 0, reference_match: 0, narration_match: t.vat_heuristic },
    },
    heuristic: { searched: true, tokens: ['SIV3762'], skipped_tokens: [], journals_matched: matches.length, truncated, limit: 100, note: '',
      matches, from_date: '2026-06-01' },
    notes: [],
  };
}
/** SIV3762's shape: JE-2026-26788 (narration) reversed the whole input VAT by hand. */
const siv3762 = () => history({ vat_heuristic: -260.87 },
  [{ tie: 'posting', vat_amount: 260.87 }, { tie: 'narration_match', vat_amount: -260.87, entry_number: 'JE-2026-26788' }]);

describe('planMirroredNote — clean bills', () => {
  it('the note carries the bill\'s own rate; the whole remainder carries the whole VAT', () => {
    expect(planMirroredNote(history({}), 1000, NO_ACK))
      .toMatchObject({ ok: true, plan: { taxAmount: 150, billVatRateNow: 15, vatOutOfProportion: 0, basis: 'mirror_bill' } });
    expect(planMirroredNote(history({}), 1739.13, NO_ACK)).toMatchObject({ ok: true, plan: { taxAmount: 260.87 } });
  });

  it('a zero-rated bill mirrors 0% VAT, not the 15% default', () => {
    expect(planMirroredNote(history({ vat_posted: 0, vat_derivable_now: 0 }), 500, NO_ACK))
      .toMatchObject({ ok: true, plan: { taxAmount: 0, taxRate: 0 } });
  });

  it('after an earlier note took half, the rate still stands and the remainder mirrors exactly', () => {
    const h = history({ vat_derivable_now: 130.44, net_base_now: 869.57 }, [{ tie: 'credit_note', vat_amount: -130.43 }]);
    expect(planMirroredNote(h, 869.57, NO_ACK)).toMatchObject({ ok: true, plan: { taxAmount: 130.44 } });
  });

  it('acknowledge on a clean bill without vat_amount is a plain mirror', () => {
    expect(planMirroredNote(history({}), 1000, ack(null))).toMatchObject({ ok: true, plan: { taxAmount: 150, basis: 'mirror_bill' } });
  });

  it('rounding of several earlier notes stays inside the tolerance (one cent per adjusting journal, plus one)', () => {
    const h = history({ vat_derivable_now: 86.94, net_base_now: 579.71 },
      [{ tie: 'credit_note', vat_amount: -86.96 }, { tie: 'credit_note', vat_amount: -86.97 }]);
    expect(planMirroredNote(h, 579.71, NO_ACK)).toMatchObject({ ok: true, plan: { taxAmount: 86.94 } });
  });
});

describe('planMirroredNote — refusals', () => {
  it('REFUSES when a heuristic match reversed the VAT (SIV3762), naming the journal and suggesting vat_amount 0', () => {
    const r = planMirroredNote(siv3762(), 1739.13, NO_ACK);
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason).toMatch(/^VAT_ALREADY_REVERSED/);
    expect(reason).toContain(`JE-2026-26788 narration_match ${formatMoney(-260.87)}`);
    expect(reason).toContain('acknowledge_vat_already_reversed: true and vat_amount: 0 ');
    expect(reason).toContain('a person must decide');
  });

  it('a POSITIVE match does not hide a real reversal: each is judged on its own (review round 2, R2-1)', () => {
    const h = history({ vat_heuristic: 0 }, [
      { tie: 'narration_match', vat_amount: -260.87, entry_number: 'JE-SLIP' },
      { tie: 'narration_match', vat_amount: 260.87, entry_number: 'JE-OTHER' },
    ]);
    const r = planMirroredNote(h, 1739.13, NO_ACK);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('2 journal(s) naming the bill moved its VAT');
    expect((r as { reason: string }).reason).toContain('vat_amount: 0 ');
  });

  it('a heuristic never writes: acknowledged needs vat_amount; with it, the stated amount is what the note carries', () => {
    expect(planMirroredNote(siv3762(), 1739.13, ack(null)).ok).toBe(false);
    expect(planMirroredNote(siv3762(), 1739.13, ack(0))).toMatchObject({ ok: true, plan: { taxAmount: 0, basis: 'mirror_bill_ack' } });
  });

  it('an acknowledged vat_amount above the derivable VAT on this share is refused', () => {
    expect(planMirroredNote(siv3762(), 1000, ack(150))).toMatchObject({ ok: true });
    expect(planMirroredNote(siv3762(), 1000, ack(150.02))).toMatchObject({ ok: false, reason: expect.stringContaining('more than the') });
  });

  it('a partial manual reversal suggests the remaining rate', () => {
    const h = history({ vat_heuristic: -100 }, [{ tie: 'reference_match', vat_amount: -100 }]);
    const r = planMirroredNote(h, 1000, NO_ACK);
    expect((r as { reason: string }).reason).toContain('vat_amount: 92.5 ');
  });

  it('a derivable out-of-proportion bill (a note at the wrong rate) is refused too', () => {
    const h = history({ vat_derivable_now: 100, net_base_now: 1739.13 }, [{ tie: 'credit_note', vat_amount: -160.87 }]);
    expect(planMirroredNote(h, 500, NO_ACK)).toMatchObject({ ok: false, reason: expect.stringContaining('less than its posted rate gives') });
  });

  it('a truncated heuristic search is refused unless acknowledged (architecture A6)', () => {
    expect(planMirroredNote(history({}, [], true), 1000, NO_ACK))
      .toMatchObject({ ok: false, reason: expect.stringContaining('search is incomplete') });
    expect(planMirroredNote(history({}, [], true), 1000, ack(150))).toMatchObject({ ok: true });
  });

  it('refuses a bill with no posted base, one already fully credited, and a subtotal above what is left', () => {
    expect(planMirroredNote(history({ net_base_posted: 0, net_base_now: 0, vat_posted: 0, vat_derivable_now: 0 }), 10, NO_ACK))
      .toMatchObject({ ok: false, reason: expect.stringContaining('no posted journal') });
    expect(planMirroredNote(history({ net_base_now: 0, vat_derivable_now: 0 }), 10, NO_ACK))
      .toMatchObject({ ok: false, reason: expect.stringContaining('nothing to mirror') });
    expect(planMirroredNote(history({}), 1739.14, NO_ACK))
      .toMatchObject({ ok: false, reason: expect.stringContaining(`more than the ${formatMoney(1739.13)}`) });
  });
});

describe('planMirroredNote — unposted drafts on the bill count', () => {
  const clean = () => history({ vat_posted: 150, vat_derivable_now: 150, net_base_posted: 1000, net_base_now: 1000 });
  const draft = (subtotal: number, tax: number, n = 'CN-9') => ({ id: `id-${n}`, credit_note_number: n, subtotal, tax_amount: tax });

  it('a second mirrored draft gets only what the first left: base and VAT less the open draft', () => {
    expect(planMirroredNote(clean(), 500, NO_ACK, [draft(500, 75)]))
      .toMatchObject({ ok: true, plan: { taxAmount: 75, netBaseNow: 500, vatNetNow: 75 } });
    expect(planMirroredNote(clean(), 600, NO_ACK, [draft(500, 75)]))
      .toMatchObject({ ok: false, reason: expect.stringContaining(`more than the ${formatMoney(500)}`) });
  });

  it('a retry that meets its own first draft is told to approve that draft', () => {
    const r = planMirroredNote(clean(), 1000, NO_ACK, [draft(1000, 150, 'CN-7')]);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('nothing to mirror') });
    expect((r as { reason: string }).reason).toContain('CN-7 (id id-CN-7) for the same subtotal is already open');
  });

  it('a draft at 15% on a zero-rated bill is out of proportion: refused and named; acknowledged with vat_amount 0, mirrors none', () => {
    const zero = history({ vat_posted: 0, vat_derivable_now: 0, net_base_posted: 1000, net_base_now: 1000 });
    const r = planMirroredNote(zero, 500, NO_ACK, [draft(500, 75, 'CN-8')]);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining(`CN-8 draft_credit_note ${formatMoney(-75)}`) });
    expect(planMirroredNote(zero, 500, ack(0), [draft(500, 75, 'CN-8')])).toMatchObject({ ok: true, plan: { taxAmount: 0 } });
  });
});
