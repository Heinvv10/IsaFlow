/**
 * Round 27 (M1, L2, L3): a single mirror whose sent-with journal is reversed as at the period end (the sender cancelled it) eliminates nothing for the
 * period. The row may still be ANOTHER sale, so the sentence is conditional: if it is the same sale there is no revenue left to eliminate (do not post
 * this); if it is another sale, it still needs this elimination. No sentence calls it "NOT eliminated automatically" or "the sale's only elimination".
 */
import { describe, expect, it } from 'vitest';
import {
  duplicateBadgeText, factsFromRows, generatorReason, isSenderCancelled, mirrorFactsSentence, parseMirrorFacts, possibleDuplicateMessage,
  type MirrorFact, type MirrorFacts,
} from '@/modules/accounting/services/reports/mirrorFacts';

const END = '2026-06-30';
const mirror = (over: Partial<MirrorFact> = {}): MirrorFact => ({ ref: 'INV-1 (mirrored)', amount: 1000, stands: false, link: 'none', byTotal: false, elimDate: '2026-04-10', otherRole: null, senderCancelled: true, ...over });
const single = (over: Partial<MirrorFact> = {}): MirrorFacts => ({ label: 'INV-1 (mirrored)', sum: false, periodEnd: END, mirrors: [mirror(over)] });
const HEAD = 'Possibly the same sale as mirrored document INV-1 (mirrored), which the sender cancelled (its journal is reversed as at 2026-06-30)';
const CONDITIONAL = 'If it is the same sale there is no revenue left to eliminate: do not post this (a posted elimination would be an over-elimination to reverse). If it is another sale, it still needs this elimination.';

describe('a single mirror whose sent-with journal is reversed as at the period end', () => {
  const f = single();
  it('is recognised only when nothing eliminates it for the period', () => {
    expect(isSenderCancelled(f)).toBe(true);
    expect(isSenderCancelled(single({ stands: true }))).toBe(false);          // (a cancel dated after the period: the mirror's own later -E)
    expect(isSenderCancelled(single({ senderCancelled: false }))).toBe(false);
    expect(isSenderCancelled({ ...f, sum: true })).toBe(false);
  });

  it('the sentence is the exact conditional wording (and the pair cutover goes in brackets after the cancel)', () => {
    expect(mirrorFactsSentence(f)).toBe(`${HEAD}. ${CONDITIONAL}`);
    expect(mirrorFactsSentence(f, '2026-03-01')).toBe(`${HEAD} (the pair mirrors from 2026-03-01). ${CONDITIONAL}`);
  });

  it('the 409 / confirm, a draft\'s badge and the generator\'s notes carry it word for word', () => {
    expect(possibleDuplicateMessage(f)).toBe(`${HEAD}. ${CONDITIONAL} Confirm to post it.`);
    expect(duplicateBadgeText(f, 'draft')).toBe(`${HEAD}. ${CONDITIONAL} Check before posting.`);
    expect(generatorReason(f, null, null, END)).toBe(`${HEAD}. ${CONDITIONAL}`);
    expect(generatorReason(f, '2026-03-01', { state: 'released', ref: 'INV-1 (mirrored)' }, END)).toBe(
      `The pair mirrors from 2026-03-01. Its link to mirrored document INV-1 (mirrored) was released: that mirror did not eliminate this row for the period to ${END} when this run was made. ${HEAD}. ${CONDITIONAL}`);
  });

  it('a posted elimination is told it is an over-elimination to reverse if it is the same sale', () => {
    expect(duplicateBadgeText(f, 'posted')).toBe(`Posted. ${HEAD}. If it is the same sale there is no revenue left to eliminate: this elimination is an over-elimination, reverse it. If it is another sale, it still needs this elimination.`);
  });

  it('never says "NOT eliminated" or "only elimination", and does not claim more than the fact shows (the journal is reversed as at the date)', () => {
    for (const text of [mirrorFactsSentence(f), duplicateBadgeText(f, 'draft'), duplicateBadgeText(f, 'posted')]) {
      expect(text).not.toMatch(/only elimination|NOT eliminated|twice/);
      expect(text).toContain('its journal is reversed as at 2026-06-30');
    }
  });

  it('a mirror that is NOT cancelled and not eliminated still says it may be the only elimination', () => {
    expect(mirrorFactsSentence(single({ senderCancelled: false }))).toMatch(/NOT eliminated automatically for the period to 2026-06-30: this may be the sale's only elimination\./);
  });
});

describe('the facts carry the state through the database row and the JSON', () => {
  it('factsFromRows reads sender_cancelled; parseMirrorFacts keeps senderCancelled', () => {
    const row = { ord: 1, label: 'INV-1 (mirrored)', is_sum: false, mirror_ref: 'INV-1 (mirrored)', amount: '1000', stands: false, link: 'none', by_total: false, elim_date: '2026-04-10', other_role: null, sender_cancelled: true };
    const f = factsFromRows([row], END)!;
    expect(f.mirrors[0]!.senderCancelled).toBe(true);
    expect(factsFromRows([{ ...row, sender_cancelled: undefined }], END)!.mirrors[0]!.senderCancelled).toBe(false);
    expect(parseMirrorFacts(JSON.parse(JSON.stringify(f)))!.mirrors[0]!.senderCancelled).toBe(true);
  });
});
