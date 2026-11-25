/**
 * Round 27 (M1, L2, L3) + round 28 (M1: a month sum whose members the sender cancelled, reachable only when the period ends after today and a future-dated
 * journal revives them, so duplicate's chain (as at the period end) and the facts' (as at today) differ): a single mirror whose sent-with journal is reversed as at the period end (the sender cancelled it) eliminates nothing for the
 * period. The row may still be ANOTHER sale, so the sentence is conditional: if it is the same sale there is no revenue left to eliminate (do not post
 * this); if it is another sale, it still needs this elimination. No sentence calls it "NOT eliminated automatically" or "the sale's only elimination".
 */
import { describe, expect, it } from 'vitest';
import { formatMoney as R } from '@/lib/money/formatMoney';
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

describe('round 28 M1: a month sum with members the sender cancelled (conditional, never "the sale\'s only elimination")', () => {
  const sum = (ms: Array<Partial<MirrorFact>>, label = '2 mirrored documents of April 2026'): MirrorFacts => ({
    label, sum: true, periodEnd: END, mirrors: ms.map((m, i) => mirror({ ref: i === 0 ? 'INV-A' : 'INV-B', amount: i === 0 ? 1000 : 500, ...m })) });
  const CANC = 'cancelled by the sender (its journal is reversed as at 2026-06-30)';
  const all = sum([{}, {}]);
  const ALL_HEAD = `Possibly the same sale as 2 mirrored documents of April 2026: INV-A (${R(1000)}: ${CANC}) and INV-B (${R(500)}: ${CANC}).`;
  const TAIL = 'If it is the same sale there is no revenue left to eliminate: do not post this (a posted elimination would be an over-elimination to reverse). If it is another sale, it still needs this elimination.';

  it('every member cancelled: each is worded as cancelled and the sentence is the single mirror\'s conditional, not "None of them ... only elimination"', () => {
    expect(mirrorFactsSentence(all)).toBe(`${ALL_HEAD} ${TAIL}`);
    expect(mirrorFactsSentence(all, '2026-03-01')).toBe(`${ALL_HEAD.slice(0, -1)} (the pair mirrors from 2026-03-01). ${TAIL}`);
    expect(possibleDuplicateMessage(all)).toBe(`${ALL_HEAD} ${TAIL} Confirm to post it.`);
    expect(duplicateBadgeText(all, 'draft')).toBe(`${ALL_HEAD} ${TAIL} Check before posting.`);
    expect(generatorReason(all, null, null, END)).toBe(`${ALL_HEAD} ${TAIL}`);
  });

  it('a posted elimination is told it is an over-elimination to reverse if it is the same sale', () => {
    expect(duplicateBadgeText(all, 'posted')).toBe(`Posted. ${ALL_HEAD} If it is the same sale there is no revenue left to eliminate: this elimination is an over-elimination, reverse it. If it is another sale, it still needs this elimination.`);
  });

  it('never says "only elimination", "NOT eliminated" or "None of them" of an all-cancelled sum', () => {
    for (const t of [mirrorFactsSentence(all), duplicateBadgeText(all, 'draft'), duplicateBadgeText(all, 'posted')]) expect(t).not.toMatch(/only elimination|NOT eliminated|None of them|twice/);
  });

  it('some cancelled, the rest NOT eliminated for another reason: names the cancelled part and what it would over-eliminate', () => {
    const f = sum([{}, { senderCancelled: false }]);
    const head = `Possibly the same sale as 2 mirrored documents of April 2026: INV-A (${R(1000)}: ${CANC}) and INV-B (${R(500)}: NOT eliminated automatically for the period to 2026-06-30).`;
    expect(mirrorFactsSentence(f)).toBe(`${head} None of them is eliminated automatically for the period to 2026-06-30. If it is the same sale, the part the sender cancelled (${R(1000)}) has no revenue left to eliminate, so posting this in full would over-eliminate it; the rest may be the sale's only elimination.`);
    expect(duplicateBadgeText(f, 'posted')).toBe(`Posted. ${head} None of them is eliminated automatically for the period to 2026-06-30. If it is the same sale, the part the sender cancelled (${R(1000)}) has no revenue left to eliminate, so this elimination over-eliminates it; the rest may be the sale's only elimination.`);
  });

  it('a cancelled member beside a standing one: the standing part is eliminated twice AND the cancelled part is over-eliminated (round 29 L2)', () => {
    const f = sum([{}, { stands: true, senderCancelled: false }]);
    const head = `Possibly the same sale as 2 mirrored documents of April 2026: INV-A (${R(1000)}: ${CANC}) and INV-B (${R(500)}: eliminated automatically, not matched to any row yet). `;
    expect(mirrorFactsSentence(f)).toBe(`${head}${R(500)} of ${R(1500)} is eliminated automatically by mirroring: if it is the same sale, `
      + `posting this in full would eliminate that part twice and over-eliminate the ${R(1000)} the sender cancelled.`);
    expect(duplicateBadgeText(f, 'posted')).toBe(`Posted. ${head}${R(500)} of ${R(1500)} is eliminated automatically by mirroring: if it is the same sale, `
      + `that part is eliminated twice and the ${R(1000)} the sender cancelled is over-eliminated. Check, and reverse this one if so.`);
  });

  it('the same, matched by total with VAT (no "R P of R T"): the cancelled part carries "with VAT"', () => {
    const f = sum([{ byTotal: true }, { stands: true, senderCancelled: false, byTotal: true }]);
    expect(mirrorFactsSentence(f).endsWith(`Only some of them are eliminated automatically by mirroring, net of their VAT: if it is the same sale, `
      + `posting this in full would eliminate that part twice and over-eliminate the ${R(1000)} with VAT the sender cancelled.`)).toBe(true);
  });

  it('a sum with no cancelled member is worded as before', () => {
    expect(mirrorFactsSentence(sum([{ senderCancelled: false }, { senderCancelled: false }]))).toMatch(/None of them is eliminated automatically for the period to 2026-06-30: this may be the sale's only elimination\.$/);
  });
});

describe('round 29 L1: a cancel is judged at LEAST(period end, today): the sentence says that date, and that a journal up to the period end may change it', () => {
  const PE = '2026-12-31'; const JA = '2026-11-22';
  const CANC = `cancelled by the sender (its journal is reversed as at ${JA})`;
  const BASE = ` Judged as at ${JA} because the period ends after today; a journal dated up to ${PE} can change this in either direction: `;
  const NOTE = `${BASE}a mirror it revives is eliminated automatically for the period and, if it is the same sale, posting this would eliminate it twice.`;
  const mk = (ms: MirrorFact[], sum: boolean, judgedAt: string | undefined = JA): MirrorFacts => ({ label: sum ? '2 mirrored documents of April 2026' : 'INV-1 (mirrored)', sum, periodEnd: PE, ...(judgedAt ? { judgedAt } : {}), mirrors: ms });
  const REVIVES = 'a mirror it revives is eliminated automatically for the period and, if it is the same sale, posting this would eliminate it twice';
  const REVERSES = "a mirror it reverses is no longer eliminated automatically and, if it is the same sale, this may be the sale's only elimination";
  const ALREADY_A = ` INV-A is already revived by a journal dated after ${JA} (that is why it is in this sum), so as at ${PE} it is eliminated automatically; what follows about a cancelled mirror holds as at ${JA} only.`;
  const single = mk([mirror()], false);
  const all = mk([mirror({ ref: 'INV-A' }), mirror({ ref: 'INV-B', amount: 500 })], true);

  it('a single mirror: "reversed as at <today>" (not the period end), then the revive note, then the advice', () => {
    expect(mirrorFactsSentence(single)).toBe(`Possibly the same sale as mirrored document INV-1 (mirrored), which the sender cancelled (its journal is reversed as at ${JA}).${NOTE} ${CONDITIONAL}`);
    expect(mirrorFactsSentence(single, '2026-03-01')).toBe(`Possibly the same sale as mirrored document INV-1 (mirrored), which the sender cancelled (its journal is reversed as at ${JA}) (the pair mirrors from 2026-03-01).${NOTE} ${CONDITIONAL}`);
    expect(duplicateBadgeText(single, 'posted')).toContain(`${NOTE.replace('posting this would eliminate it twice', 'this elimination eliminates it twice')} If it is the same sale there is no revenue left to eliminate: this elimination is an over-elimination, reverse it.`);
    expect(NOTE).toContain('if it is the same sale');   // (conditional: the row may be another sale)
  });

  it('an all-cancelled sum: every member and the head say <today>, and the note follows', () => {
    const already = ` INV-A and INV-B are already revived by a journal dated after ${JA} (that is why they are in this sum), so as at ${PE} they are eliminated automatically; what follows about a cancelled mirror holds as at ${JA} only.`;
    expect(mirrorFactsSentence(all)).toBe(`Possibly the same sale as 2 mirrored documents of April 2026: INV-A (${R(1000)}: ${CANC}) and INV-B (${R(500)}: ${CANC}).${NOTE}${already} ${CONDITIONAL}`);
    expect(generatorReason(all, null, null, PE)).toBe(mirrorFactsSentence(all));
    expect(mirrorFactsSentence(all)).not.toContain(`reversed as at ${PE}`);
  });

  it('a partly cancelled sum (the rest not eliminated, or standing) carries the date and the note too', () => {
    const rest = mk([mirror({ ref: 'INV-A' }), mirror({ ref: 'INV-B', amount: 500, senderCancelled: false })], true);
    expect(mirrorFactsSentence(rest)).toContain(`(${R(1000)}: ${CANC}) and INV-B (${R(500)}: NOT eliminated automatically for the period to ${PE}).${NOTE}${ALREADY_A} None of them`);
    const stand = mk([mirror({ ref: 'INV-A' }), mirror({ ref: 'INV-B', amount: 500, stands: true, senderCancelled: false })], true);
    expect(mirrorFactsSentence(stand)).toContain(`${BASE}${REVIVES}; ${REVERSES}.${ALREADY_A} ${R(500)} of ${R(1500)} is eliminated`);
  });

  it('no note where nothing is cancelled, and none when the period does not end after today (judged_at = period end, or absent)', () => {
    expect(mirrorFactsSentence(mk([mirror({ senderCancelled: false })], false))).not.toContain('may change this');
    expect(mirrorFactsSentence({ ...single, judgedAt: PE })).toBe(`Possibly the same sale as mirrored document INV-1 (mirrored), which the sender cancelled (its journal is reversed as at ${PE}). ${CONDITIONAL}`);
    expect(mirrorFactsSentence({ ...single, judgedAt: undefined })).toContain(`reversed as at ${PE}). If it`);
  });

  it('judged_at travels: factsFromRows (a text date) and parseMirrorFacts keep it', () => {
    const row = { ord: 1, label: 'INV-1 (mirrored)', is_sum: false, mirror_ref: 'INV-1 (mirrored)', amount: '1000', stands: false, link: 'none', by_total: false, elim_date: '2026-04-10', other_role: null, sender_cancelled: true, judged_at: JA };
    const f = factsFromRows([row], PE)!;
    expect(f.judgedAt).toBe(JA);
    expect(parseMirrorFacts(JSON.parse(JSON.stringify(f)))!.judgedAt).toBe(JA);
    expect(factsFromRows([{ ...row, judged_at: undefined }], PE)!.judgedAt).toBeUndefined();
  });
});

describe('round 30 L1: the judged-date note is said of ANY mirror judged as at today, in both directions, conditionally', () => {
  const PE = '2026-12-31'; const JA = '2026-11-22';
  const BASE = ` Judged as at ${JA} because the period ends after today; a journal dated up to ${PE} can change this in either direction: `;
  const REVIVES = 'a mirror it revives is eliminated automatically for the period and, if it is the same sale, posting this would eliminate it twice';
  const REVERSES = "a mirror it reverses is no longer eliminated automatically and, if it is the same sale, this may be the sale's only elimination";
  const one = (over: Partial<MirrorFact>, judgedAt: string | undefined = JA): MirrorFacts => ({ label: 'INV-1 (mirrored)', sum: false, periodEnd: PE, ...(judgedAt ? { judgedAt } : {}), mirrors: [mirror(over)] });
  const HEAD = 'Possibly the same sale as mirrored document INV-1 (mirrored), which is ';

  it('Scenario A: a mirror NOT eliminated as at today (not cancelled by the sender) gets the note: a later journal may revive it, and then posting eliminates it twice', () => {
    expect(mirrorFactsSentence(one({ senderCancelled: false }))).toBe(
      `${HEAD}NOT eliminated automatically for the period to ${PE}: this may be the sale's only elimination.${BASE}${REVIVES}.`);
  });

  it('Scenario B: a STANDING mirror gets the note: a later journal may reverse it, and then this may be the sale\'s only elimination', () => {
    expect(mirrorFactsSentence(one({ stands: true, senderCancelled: false }))).toBe(
      `${HEAD}eliminated automatically and is not matched to any row yet. If it is the same sale, posting this would eliminate it twice.${BASE}${REVERSES}.`);
  });

  it('a posted elimination: the same, in the posted tense', () => {
    expect(duplicateBadgeText(one({ senderCancelled: false }), 'posted')).toBe(
      `Posted. ${HEAD}NOT eliminated automatically for the period to ${PE}: this may be the sale's only elimination.${BASE}${REVIVES.replace('posting this would eliminate it twice', 'this elimination eliminates it twice')}.`);
    expect(duplicateBadgeText(one({ stands: true, senderCancelled: false }), 'posted')).toContain(
      `${BASE}${REVERSES.replace("this may be the sale's only elimination", "this elimination may be the sale's only one")}. Check, and reverse this one if so.`);
  });

  it('a sum of standing members, and a sum with none standing, carry the note too (and no "already revived" clause: nothing in it is cancelled)', () => {
    const sum = (a: Partial<MirrorFact>, b: Partial<MirrorFact>): MirrorFacts => ({ label: '2 mirrored documents of April 2026', sum: true, periodEnd: PE, judgedAt: JA,
      mirrors: [mirror({ ref: 'INV-A', senderCancelled: false, ...a }), mirror({ ref: 'INV-B', amount: 500, senderCancelled: false, ...b })] });
    expect(mirrorFactsSentence(sum({ stands: true }, { stands: true }))).toMatch(new RegExp(`\\.${BASE.replace(/[.()]/g, '\\$&')}${REVERSES.replace(/[.()']/g, '\\$&')}\\. All of them are eliminated automatically`));
    expect(mirrorFactsSentence(sum({}, {}))).toContain(`${BASE}${REVIVES}. None of them is eliminated automatically`);
    expect(mirrorFactsSentence(sum({ stands: true }, {}))).toContain(`${BASE}${REVIVES}; ${REVERSES}. `);
    expect(mirrorFactsSentence(sum({}, {}))).not.toContain('already revived');
  });

  it('no note when the period does not end after today (judged_at = the period end, or absent)', () => {
    for (const over of [{ senderCancelled: false }, { stands: true, senderCancelled: false }]) {
      expect(mirrorFactsSentence(one(over, PE))).not.toContain('Judged as at');
      expect(mirrorFactsSentence({ ...one(over), judgedAt: undefined })).not.toContain('Judged as at');
    }
  });

  it('L2: the cancelled note is conditional ("if it is the same sale"), and says so where a reviving journal is already counted (a month sum)', () => {
    const f = one({});
    expect(mirrorFactsSentence(f)).toContain('a mirror it revives is eliminated automatically for the period and, if it is the same sale, posting this would eliminate it twice');
    expect(mirrorFactsSentence(f)).not.toContain('already revived');
    const sum: MirrorFacts = { label: '2 mirrored documents of April 2026', sum: true, periodEnd: PE, judgedAt: JA, mirrors: [mirror({ ref: 'INV-A' }), mirror({ ref: 'INV-B', amount: 500 })] };
    expect(mirrorFactsSentence(sum)).toContain(`INV-A and INV-B are already revived by a journal dated after ${JA} (that is why they are in this sum), so as at ${PE} they are eliminated automatically; what follows about a cancelled mirror holds as at ${JA} only.`);
    expect(mirrorFactsSentence(sum)).toContain('If it is the same sale there is no revenue left to eliminate: do not post this');   // the advice branch is kept
  });
});
