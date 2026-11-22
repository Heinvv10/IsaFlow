/**
 * Round 26, M2: a mirror the SENDER cancelled (as at the period end) eliminates nothing and there is no revenue left to eliminate, so no sentence
 * calls it "the sale's only elimination" or "NOT eliminated automatically" (which invites the person to eliminate revenue that is gone).
 */
import { describe, expect, it } from 'vitest';
import {
  duplicateBadgeText, factsFromRows, generatorReason, isSenderCancelled, mirrorFactsSentence, parseMirrorFacts, possibleDuplicateMessage, SENDER_CANCELLED,
  type MirrorFact, type MirrorFacts,
} from '@/modules/accounting/services/reports/mirrorFacts';

const END = '2026-06-30';
const mirror = (over: Partial<MirrorFact> = {}): MirrorFact => ({ ref: 'INV-1 (mirrored)', amount: 1000, stands: false, link: 'none', byTotal: false, elimDate: '2026-04-10', otherRole: null, senderCancelled: true, ...over });
const single = (over: Partial<MirrorFact> = {}): MirrorFacts => ({ label: 'INV-1 (mirrored)', sum: false, periodEnd: END, mirrors: [mirror(over)] });
const WORDS = /the sender cancelled .*there is no revenue left to eliminate/;

describe('a single mirror the sender cancelled', () => {
  const f = single();
  it('is recognised only when nothing eliminates it for the period', () => {
    expect(isSenderCancelled(f)).toBe(true);
    expect(isSenderCancelled(single({ stands: true }))).toBe(false);          // (a cancel dated after the period: the mirror's own later -E)
    expect(isSenderCancelled(single({ senderCancelled: false }))).toBe(false);
    expect(isSenderCancelled({ ...f, sum: true })).toBe(false);
  });

  it.each([
    ['the sentence', mirrorFactsSentence(f)],
    ['the sentence with a pair cutover', mirrorFactsSentence(f, '2026-03-01')],
    ['the 409 and the confirm', possibleDuplicateMessage(f)],
    ['a draft\'s badge', duplicateBadgeText(f, 'draft')],
    ['a posted badge', duplicateBadgeText(f, 'posted')],
    ['the generator\'s note, before the cutover', generatorReason(f, null, null, END)],
    ['the generator\'s note, after the cutover', generatorReason(f, '2026-03-01', { state: 'released', ref: 'INV-1 (mirrored)' }, END)],
  ])('%s says the sender cancelled it and never "the only elimination" or "NOT eliminated"', (_n, text) => {
    expect(text).toMatch(WORDS);
    expect(text).not.toMatch(/only elimination|NOT eliminated|twice/);
  });

  it('the generator\'s skip detail is the same words', () => {
    expect(SENDER_CANCELLED).toBe('the sender cancelled it; there is no revenue left to eliminate');
  });

  it('a mirror that is NOT cancelled and not eliminated still says it may be the only elimination', () => {
    expect(mirrorFactsSentence(single({ senderCancelled: false }))).toMatch(/NOT eliminated automatically for the period to 2026-06-30: this may be the sale's only elimination\./);
  });
});

describe('a month sum', () => {
  const sum = (a: Partial<MirrorFact>, b: Partial<MirrorFact>): MirrorFacts => ({ label: '2 mirrored documents of April 2026', sum: true, periodEnd: END,
    mirrors: [mirror({ ref: 'A', amount: 600, ...a }), mirror({ ref: 'B', amount: 400, ...b })] });

  it('of mirrors the sender cancelled says so, not "the only elimination"', () => {
    const text = mirrorFactsSentence(sum({}, {}));
    expect(text).toMatch(/The sender cancelled them: there is no revenue left to eliminate\./);
    expect(text).not.toMatch(/only elimination/);
  });

  it('with one cancelled member names it in the list', () => {
    expect(mirrorFactsSentence(sum({ senderCancelled: false, stands: true }, {}))).toMatch(/B \(R\s?400\.00: cancelled by the sender as at 2026-06-30\)/);
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
