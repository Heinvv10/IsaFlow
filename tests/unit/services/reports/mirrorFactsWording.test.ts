/**
 * Round 19 (architecture): every sentence about a possible mirrored duplicate is worded from the row's verified mirror facts (mirrorFacts.ts).
 * One table enumerates the fact combinations, single / month sum x stands / partly / none x linked here / elsewhere / unlinked x before /
 * after the pair's cutover, for each surface (the generator's note, the draft and posted badge, the 409 and confirm), and checks that each
 * claim the text makes is one the facts carry, and that each fact the text must state is stated.
 */
import { describe, expect, it } from 'vitest';
import {
  duplicateBadgeText, generatorReason, mirrorFactsSentence, parseMirrorFacts, possibleDuplicateMessage,
  type MirrorFact, type MirrorFacts, type MirrorLinkState,
} from '@/modules/accounting/services/reports/mirrorFacts';
import { formatMoney as R } from '@/lib/money/formatMoney';

const END = '2026-03-31';
const LINKS: MirrorLinkState[] = ['here', 'elsewhere', 'none'];
type Standing = 'stands' | 'partly' | 'none';

function factsFor(kind: 'single' | 'sum', standing: Standing, link: MirrorLinkState): MirrorFacts | null {
  if (kind === 'single') {
    if (standing === 'partly') return null;   // (one mirror stands or not)
    return { label: 'INV-1 (mirrored)', sum: false, periodEnd: END, mirrors: [{ ref: 'INV-1 (mirrored)', amount: 1000, stands: standing === 'stands', link }] };
  }
  const stands = standing === 'stands' ? [true, true] : standing === 'partly' ? [true, false] : [false, false];
  // the link state is the FIRST member's (the second is unlinked), so each member's own wording is checked against its own facts
  const mirrors: MirrorFact[] = [{ ref: 'INV-A (mirrored)', amount: 600, stands: stands[0]!, link }, { ref: 'INV-B (mirrored)', amount: 400, stands: stands[1]!, link: 'none' }];
  return { label: '2 mirrored documents of March 2026', sum: true, periodEnd: END, mirrors };
}

/** The claims a text makes, read back from it. */
function claims(text: string) {
  return {
    notEliminated: /NOT eliminated automatically for the period to 2026-03-31/.test(text),
    eliminated: /\beliminated automatically(?!\s+for the period)/.test(text.replace(/NOT eliminated automatically for the period to 2026-03-31/g, '')),
    elsewhere: /matched to a different row/.test(text),
    here: /matched to this row/.test(text),
    unmatched: /not matched to any row yet/.test(text),
    onlyElimination: /may be the sale's only elimination/.test(text),
    twice: /twice/.test(text),
    cutover: /mirrors from 2026-03-01/.test(text),
    stale: /at the moment|already eliminates another row|post it if it is correct|mirrored document \d+ mirrored documents/.test(text),
  };
}

function expectTrue(text: string, f: MirrorFacts, cutover: string | null) {
  const c = claims(text);
  const P = f.mirrors.filter((m) => m.stands).reduce((s, m) => s + m.amount, 0);
  const T = f.mirrors.reduce((s, m) => s + m.amount, 0);
  expect(c.stale).toBe(false);
  expect(c.cutover).toBe(cutover !== null);
  expect(c.notEliminated).toBe(f.mirrors.some((m) => !m.stands));
  expect(c.eliminated).toBe(P > 0);
  expect(c.elsewhere).toBe(f.mirrors.some((m) => m.stands && m.link === 'elsewhere'));
  expect(c.here).toBe(f.mirrors.some((m) => m.stands && m.link === 'here'));
  expect(c.unmatched).toBe(f.mirrors.some((m) => m.stands && m.link === 'none'));
  expect(c.onlyElimination).toBe(P === 0);
  expect(c.twice).toBe(P > 0);
  for (const m of f.mirrors) expect(text).toContain(m.ref);
  if (f.sum) {
    for (const m of f.mirrors) expect(text).toContain(`${m.ref} (${R(m.amount)}: ${m.stands ? 'eliminated automatically' : 'NOT eliminated'}`);
    if (P > 0) expect(text).toContain(`${R(P)} of ${R(T)} is eliminated automatically by mirroring`);
    expect(/by mirroring, in full/.test(text)).toBe(P > 0 && P === T);
    expect(/that part/.test(text)).toBe(P > 0 && P < T);
  }
}

const cases = (['single', 'sum'] as const).flatMap((kind) => (['stands', 'partly', 'none'] as const).flatMap((standing) =>
  LINKS.flatMap((link) => [null, '2026-03-01'].map((cutover) => ({ kind, standing, link, cutover, f: factsFor(kind, standing, link) })))))
  .filter((c): c is typeof c & { f: MirrorFacts } => c.f !== null);

describe('every surface states exactly what the facts show (table of fact combinations)', () => {
  it('enumerates every combination (2 single standings and 3 sum standings, x 3 link states x before / after the cutover)', () => {
    expect(cases.length).toBe((2 + 3) * 3 * 2);
  });

  it.each(cases.map((c) => [`${c.kind} ${c.standing} linked:${c.link} ${c.cutover ? 'post' : 'pre'}-cutover`, c] as const))('%s', (_name, c) => {
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
  const f = factsFor('single', 'none', 'none')!;
  it('released: names the released mirror and why; closer: names the mirror kept for the closer row; no facts: says no mirror matches', () => {
    expect(generatorReason(f, '2026-03-01', { state: 'released', ref: 'OLD' }, END))
      .toBe(`The pair mirrors from 2026-03-01. Its link to mirrored document OLD was released: that mirror no longer eliminates this row for the period to ${END}. ${mirrorFactsSentence(f)}`);
    expect(generatorReason(f, '2026-03-01', { state: 'closer', ref: 'NEAR' }, END)).toContain('Mirrored document NEAR belongs to a closer row');
    expect(generatorReason(null, '2026-03-01', { state: 'none', ref: '' }, END)).toBe('The pair mirrors from 2026-03-01. No mirrored document matches this row.');
    expect(generatorReason(null, null, null, END)).toBe('');
  });

  it('malformed facts from the API are refused, never half-read', () => {
    expect(parseMirrorFacts(null)).toBeNull();
    expect(parseMirrorFacts({ label: 'x', periodEnd: END, mirrors: [] })).toBeNull();
    expect(parseMirrorFacts({ label: 'x', periodEnd: END, mirrors: [{ ref: 'a', amount: 'NaN' }] })).toBeNull();
  });
});
