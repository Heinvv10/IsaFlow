/**
 * Round 19 (architecture): every sentence about a possible mirrored duplicate is worded from the row's verified mirror facts (mirrorFacts.ts).
 * One table enumerates the fact combinations, single / month sum x stands / partly / none x linked here / elsewhere / unlinked x before /
 * after the pair's cutover, for each surface (the generator's note, the draft and posted badge, the 409 and confirm), and checks that each
 * claim the text makes is one the facts carry, and that each fact the text must state is stated.
 */
import { describe, expect, it } from 'vitest';
import {
  duplicateBadgeText, generatorReason, linkedMirrorState, mirrorFactsSentence, NO_MIRROR_MATCH, parseMirrorFacts, possibleDuplicateMessage,
  type MirrorFact, type MirrorFacts, type MirrorLinkState,
} from '@/modules/accounting/services/reports/mirrorFacts';
import { formatMoney as R } from '@/lib/money/formatMoney';

const END = '2026-03-31';
const LINKS: MirrorLinkState[] = ['here', 'elsewhere', 'none'];
type Standing = 'stands' | 'partly' | 'none';
/** Round 20: plain; a credit note in the sum (negative); matched by totals with VAT; eliminated after the period; held by the other role. */
type Variant = 'plain' | 'creditNote' | 'byTotal' | 'late' | 'otherRole';
const VARIANTS: Variant[] = ['plain', 'creditNote', 'byTotal', 'late', 'otherRole'];

function factsFor(kind: 'single' | 'sum', standing: Standing, link: MirrorLinkState, v: Variant): MirrorFacts | null {
  if (v === 'otherRole' && link !== 'none') return null;          // (the other role's link is said only where no link of this role holds it)
  const extra = (m: MirrorFact): MirrorFact => ({ ...m, byTotal: m.byTotal ?? false, elimDate: v === 'late' ? '2026-04-03' : '2026-03-10', otherRole: v === 'otherRole' ? 'purchase' : null, senderCancelled: false });
  if (kind === 'single') {
    if (standing === 'partly' || v === 'creditNote' || v === 'byTotal') return null;   // (one mirror stands or not; the sum-only variants)
    return { label: 'INV-1 (mirrored)', sum: false, periodEnd: END, mirrors: [extra({ ref: 'INV-1 (mirrored)', amount: 1000, stands: standing === 'stands', link })] };
  }
  const stands = standing === 'stands' ? [true, true] : standing === 'partly' ? [true, false] : [false, false];
  // the link state is the FIRST member's (the second is unlinked), so each member's own wording is checked against its own facts
  const amounts = v === 'creditNote' ? [1000, -200] : v === 'byTotal' ? [690, 460] : [600, 400];
  const mirrors: MirrorFact[] = [
    extra({ ref: 'INV-A (mirrored)', amount: amounts[0]!, stands: stands[0]!, link, byTotal: v === 'byTotal' }),
    { ...extra({ ref: 'INV-B (mirrored)', amount: amounts[1]!, stands: stands[1]!, link: 'none', byTotal: v === 'byTotal' }), otherRole: null },
  ];
  return { label: '2 mirrored documents of March 2026', sum: true, periodEnd: END, mirrors };
}

/** The claims a text makes, read back from it. */
function claims(text: string) {
  const without = text.replace(/NOT eliminated automatically for the period to 2026-03-31/g, '');
  return {
    notEliminated: /NOT eliminated automatically for the period to 2026-03-31/.test(text),
    eliminated: /\beliminated automatically(?!\s+for the period)/.test(without.replace(/None of them is eliminated automatically/g, '')),
    elsewhere: /matched to a different row/.test(text),
    here: /matched to this row/.test(text),
    unmatched: /not matched to any row yet/.test(text),
    otherRole: /matched to a purchase row \(the other side of a sale\), not to any sale row yet/.test(text),
    onlyElimination: /may be the sale's only elimination/.test(text),
    twice: /twice/.test(text),
    cutover: /mirrors from 2026-03-01/.test(text),
    late: /on 2026-04-03, after the period to 2026-03-31/.test(text),
    vat: /with VAT/.test(text),
    netOfVat: /net of their VAT/.test(text),
    stale: /at the moment|already eliminates another row|post it if it is correct|mirrored document \d+ mirrored documents|in full:|no longer eliminates/.test(text),
  };
}

function expectTrue(text: string, f: MirrorFacts, cutover: string | null) {
  const c = claims(text);
  const standing = f.mirrors.filter((m) => m.stands);
  const P = standing.reduce((s, m) => s + m.amount, 0);
  const T = f.mirrors.reduce((s, m) => s + m.amount, 0);
  const byTotal = f.mirrors.some((m) => m.byTotal);
  expect(c.stale).toBe(false);
  expect(c.cutover).toBe(cutover !== null);
  expect(c.notEliminated).toBe(f.mirrors.some((m) => !m.stands));
  expect(c.eliminated).toBe(standing.length > 0);
  expect(c.elsewhere).toBe(standing.some((m) => m.link === 'elsewhere'));
  expect(c.here).toBe(standing.some((m) => m.link === 'here'));
  expect(c.unmatched).toBe(standing.some((m) => m.link === 'none' && !m.otherRole));
  expect(c.otherRole).toBe(standing.some((m) => m.link === 'none' && m.otherRole === 'purchase'));
  expect(c.late).toBe(standing.some((m) => (m.elimDate ?? '') > END));
  expect(c.onlyElimination).toBe(standing.length === 0);
  expect(c.twice).toBe(standing.length > 0);
  for (const m of f.mirrors) expect(text).toContain(m.ref);
  if (f.sum) {
    expect(c.vat).toBe(byTotal);
    expect(c.netOfVat).toBe(byTotal && standing.length > 0);
    for (const m of f.mirrors) expect(text).toContain(`${m.ref} (${R(m.amount)}${byTotal ? ' with VAT' : ''}: ${m.stands ? 'eliminated automatically' : 'NOT eliminated'}`);
    const partial = standing.length > 0 && standing.length < f.mirrors.length;
    const sameSign = f.mirrors.every((m) => Math.sign(m.amount) === Math.sign(T));
    // "R P of R T" only where it is a true part of the row: never more than the row, never a credit note's sign, never a total with VAT
    expect(text.includes(`${R(P)} of ${R(T)} is eliminated automatically by mirroring`)).toBe(partial && sameSign && !byTotal);
    if (text.includes(' of R')) expect(Math.abs(P)).toBeLessThan(Math.abs(T));
    expect(/All of them are eliminated automatically/.test(text)).toBe(standing.length === f.mirrors.length);
    expect(/Only some of them/.test(text)).toBe(partial && (!sameSign || byTotal));
    expect(/that part/.test(text)).toBe(partial);
  }
}

const cases = (['single', 'sum'] as const).flatMap((kind) => (['stands', 'partly', 'none'] as const).flatMap((standing) =>
  LINKS.flatMap((link) => VARIANTS.flatMap((variant) => [null, '2026-03-01'].map((cutover) => ({ kind, standing, link, variant, cutover, f: factsFor(kind, standing, link, variant) }))))))
  .filter((c): c is typeof c & { f: MirrorFacts } => c.f !== null);

describe('every surface states exactly what the facts show (table of fact combinations)', () => {
  it('enumerates every combination (standings x link states x variants x before / after the cutover)', () => {
    // single: 2 standings x (3 links x [plain, late] + the unlinked otherRole); sum: 3 standings x (3 links x 4 variants + otherRole)
    expect(cases.length).toBe((2 * (3 * 2 + 1) + 3 * (3 * 4 + 1)) * 2);
  });

  it.each(cases.map((c) => [`${c.kind} ${c.standing} linked:${c.link} ${c.variant} ${c.cutover ? 'post' : 'pre'}-cutover`, c] as const))('%s', (_name, c) => {
    const { f, cutover } = c;
    const confirm = possibleDuplicateMessage(f, cutover);
    expectTrue(confirm, f, cutover);
    expect(confirm.endsWith(' Confirm to post it.')).toBe(true);
    const draft = duplicateBadgeText(f, 'draft', cutover);
    expectTrue(draft, f, cutover);
    expect(draft.endsWith(' Check before posting.')).toBe(true);
    const posted = duplicateBadgeText(f, 'posted', cutover);
    expectTrue(posted, f, cutover);
    expect(/posting this/.test(posted)).toBe(false);                       // (already posted)
    expect(/reverse this one/.test(posted)).toBe(f.mirrors.some((m) => m.stands));
    const note = generatorReason(f, cutover, { state: 'taken', ref: 'INV-X' }, END);
    expectTrue(note, f, cutover);
    expect(note).not.toContain('INV-X');                                   // ('taken' carries no claim of its own: the facts say it)
    expect(parseMirrorFacts(JSON.parse(JSON.stringify(f)))).toEqual(f);   // (the facts survive the API)
  });
});

describe('the link\'s own answers after the cutover', () => {
  const f = factsFor('single', 'none', 'none', 'plain')!;
  it('released: names the released mirror and why; closer: names the mirror kept for the closer row; no facts: says no mirror matches', () => {
    expect(generatorReason(f, '2026-03-01', { state: 'released', ref: 'OLD' }, END))
      .toBe(`The pair mirrors from 2026-03-01. Its link to mirrored document OLD was released: that mirror did not eliminate this row for the period to ${END} when this run was made. ${mirrorFactsSentence(f)}`);
    expect(generatorReason(f, '2026-03-01', { state: 'closer', ref: 'NEAR' }, END)).toContain('Mirrored document NEAR belongs to a closer row');
    expect(generatorReason(null, '2026-03-01', { state: 'none', ref: '' }, END)).toBe(`The pair mirrors from 2026-03-01. ${NO_MIRROR_MATCH}`);
    expect(generatorReason(null, null, null, END)).toBe('');
  });

  it('malformed facts from the API are refused, never half-read', () => {
    expect(parseMirrorFacts(null)).toBeNull();
    expect(parseMirrorFacts({ label: 'x', periodEnd: END, mirrors: [] })).toBeNull();
    expect(parseMirrorFacts({ label: 'x', periodEnd: END, mirrors: [{ ref: 'a', amount: 'NaN' }] })).toBeNull();
  });
});

describe('R21 M2: linkedMirrorState (a row left to mirroring)', () => {
  const f = (elimDate: string, link: MirrorLinkState = 'here'): MirrorFacts => ({ label: 'INV-1', sum: false, periodEnd: END,
    mirrors: [{ ref: 'INV-1', amount: 1000, stands: true, link, byTotal: false, elimDate, otherRole: null }] });
  it('an elimination inside the period: matched to this row, no date', () => {
    expect(linkedMirrorState(f('2026-03-10'), 'INV-1')).toBe('eliminated automatically and is matched to this row');
  });
  it('an elimination after the period: the date and the period end are said (the later document date)', () => {
    expect(linkedMirrorState(f('2026-04-03'), 'INV-1')).toBe('eliminated automatically on 2026-04-03, after the period to 2026-03-31, and is matched to this row');
  });
  it('names the mirror the link holds, else the one the answer names, else the first', () => {
    const two: MirrorFacts = { label: '2 mirrored documents', sum: true, periodEnd: END, mirrors: [
      { ref: 'A', amount: 1, stands: true, link: 'none', elimDate: '2026-03-01' }, { ref: 'B', amount: 1, stands: true, link: 'here', elimDate: '2026-04-09' }] };
    expect(linkedMirrorState(two, 'A')).toContain('2026-04-09');
    expect(linkedMirrorState({ ...two, mirrors: two.mirrors.map((m) => ({ ...m, link: 'none' as const })) }, 'B')).toContain('2026-04-09');
  });
});
