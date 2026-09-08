/**
 * ONE MEASURE, TWO SHEETS, AND ONLY ONE OF THEM KNEW ITS OWN SIGN.
 *
 * Page 5 presented EBITDA as "operating profit plus the depreciation and
 * amortisation CHARGED in the period". Page 12 — the glossary — was made
 * sign-aware in an earlier round: it says the movement can be a net credit,
 * that the add-back is then negative, and that EBITDA sits below operating
 * profit. Brightsphere is that company: (1 819) plus (152) lands at (1 971),
 * and against page 5's sentence that arithmetic reads as a sign error, which
 * is the exact misreading page 12's clause exists to prevent.
 *
 * Nothing was charged, so page 5 was FALSE there and true on the demo — the
 * boilerplate-versus-sign-aware split this branch keeps finding.
 *
 * The fix is not a second sign-aware branch. "The movement on depreciation
 * and amortisation" is true whichever way those accounts ran; page 12 keeps
 * the sign clause, beside the reconciliation that prompts the question.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { DA_ADD_BACK } from '@/modules/accounting/services/packs/pages/packDefinitions';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoRenderedInput,
  Brightsphere: brightsphereLiveInput,
};

/** The EBITDA sentence as sheet 5 composes it. */
function ebitdaNote(input: BoardPackInput): string {
  const page = buildBoardPackPages(input).pages.find((p) => p.number === 5)!;
  const note = page.blocks
    .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []))
    .map((n) => n.body)
    .find((body) => body.includes('EBITDA'));
  expect(note, 'sheet 5 states no EBITDA').toBeDefined();
  return note!;
}

describe('sheet 5 defines EBITDA in terms true of either sign', () => {
  it('is not vacuous — one company credited those accounts and the other charged them', () => {
    const signs = Object.entries(COMPANIES).map(([name, input]) => [name, input.set.current.depreciation] as const);
    expect(signs.some(([, d]) => d < 0), 'no fixture has a net credit, so the defect is unreachable').toBe(true);
    expect(signs.some(([, d]) => d > 0), 'no fixture charged any, so the mirror case is untested').toBe(true);
  });

  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`says nothing about charging on ${company}`, () => {
      const note = ebitdaNote(input);
      // "CHARGED in the period" is false on a company that reversed more out
      // of those accounts than it posted in.
      expect(note, `${company}: sheet 5 claims the add-back is what was charged`)
        .not.toMatch(/charged in the period/i);
      // And the measure is still identified by what is in it.
      expect(note).toContain('depreciation and amortisation');
      expect(note).toContain('not because a standard requires it');
    });
  }

  it('says the same thing on both companies', () => {
    // A sentence that BRANCHES on the sign is the defect in its other
    // direction: page 12 explains the credit, once, beside the reconciliation.
    const [a, b] = Object.values(COMPANIES).map(ebitdaNote);
    const definition = (note: string) => note.slice(note.indexOf('It is operating profit'));
    expect(definition(a!)).toBe(definition(b!));
  });
});

/**
 * ONE MEASURE, ONE WORDING, ON EVERY SHEET THAT DEFINES IT.
 *
 * Page 5 said EBITDA is "operating profit plus the MOVEMENT on depreciation
 * and amortisation"; page 12's ordinary arm said "plus the depreciation and
 * amortisation CHARGED in the period". Both give +77 on the demo company, so
 * nothing was disproved by it — and page 12's own credited arm already said
 * "movement", precisely because Brightsphere's add-back is a net credit of
 * (152) and "charged" would be false there. So the demo's basis page defined
 * its measure in words its own page 5 does not use, and in words that could
 * not travel to the other company.
 *
 * "Movement" is right in both directions and is now the pack's one wording,
 * shared as a constant rather than restated — which is what stops the two
 * sheets drifting again.
 */
describe('EBITDA is defined the same way wherever the pack defines it', () => {
  const definitionsOf = (input: Parameters<typeof buildBoardPackPages>[0]): string => {
    const doc = buildBoardPackPages(input);
    return doc.pages
      .flatMap((page) => page.blocks)
      .flatMap((b) => (b.kind === 'definitions'
        ? b.entries.filter((e) => e.term === 'EBITDA').map((e) => e.definition)
        : b.kind === 'disclosure'
          ? b.disclosure.notes.filter((n) => n.body.includes('EBITDA')).map((n) => n.body)
          : []))
      .join(' || ');
  };

  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`says "${DA_ADD_BACK}" and never "charged in the period" on ${company}`, () => {
      const prose = definitionsOf(input);
      expect(prose, `${company} defines EBITDA nowhere`).toContain('EBITDA');
      // The wording that cannot travel: it is false on a net-credit movement.
      expect(prose).not.toContain('depreciation and amortisation charged in the period');
      // And every sheet that explains the add-back uses the one that can.
      const explains = prose.split(' || ').filter((s2) => /operating profit plus/.test(s2));
      expect(explains.length, `${company} explains the add-back nowhere`).toBeGreaterThan(0);
      for (const sentence of explains) {
        expect(sentence, `${company}: "${sentence}"`).toContain(DA_ADD_BACK);
      }
    });
  }

  it('is one constant, so the two sheets cannot drift apart again', () => {
    // Mutating the constant must move BOTH pages. Two string literals that
    // happen to match are what the pack had.
    expect(DA_ADD_BACK).toBe('the movement on depreciation and amortisation');
    const demo = definitionsOf(COMPANIES['the demo company']!);
    expect(demo.split(DA_ADD_BACK).length - 1,
      'only one sheet states the add-back, so the shared wording proves nothing')
      .toBeGreaterThan(1);
  });
});
