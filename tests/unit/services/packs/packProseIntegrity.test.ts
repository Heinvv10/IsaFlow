/**
 * THE PACK MUST NOT PRINT ITS OWN PLUMBING — held to it on the COMPOSED
 * document, which is the artefact a director receives.
 *
 * Six leaks on the rendered proofs turned out to be one defect class (see
 * `packProseIntegrity.ts`), so fixing six strings would have left the seventh
 * to the next company whose ledger is untidy. These tests do two things a
 * string-by-string fix cannot: they prove the gate REFUSES each shape of leak
 * — planted into a real composed document, one at a time — and they prove
 * every fixture the suite carries comes through it clean.
 *
 * Each planted case is a real sentence the pack printed, not an invented one.
 */
import { describe, expect, it } from 'vitest';
import { checkProse } from '@/modules/accounting/services/packs/figures/packProseIntegrity';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  brightsphereInput,
  demoInput,
  denseInput,
  noRatioPanelsInput,
} from './fixtures/boardPackInputs';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

const clean = buildBoardPackPages(demoInput);

/** The document with one sentence replaced on page 12's basis disclosure —
 *  the block every one of the real leaks landed in or beside. */
function withNote(body: string): PackPagesDocument {
  const pages = clean.pages.map((page) => {
    if (page.number !== clean.pages.length) return page;
    return {
      ...page,
      blocks: [
        ...page.blocks,
        { kind: 'disclosure' as const, disclosure: { heading: 'Caveats', notes: [{ heading: 'Caveat 1', body }] } },
      ],
    };
  });
  return { ...clean, pages };
}

describe('checkProse — the leaks that actually shipped', () => {
  const PLANTED: Array<[string, string, RegExp]> = [
    [
      'a database column and an instruction to a system administrator',
      "No GL account is classified as inventory. Set account_subtype to 'inventory' on the stock control account.",
      /schema identifier/,
    ],
    [
      "this project's own specification, quoted to directors",
      'Spec §4.A asks for 6 panels and 4 are drawn.',
      /internal specification reference/,
    ],
    [
      "a developer's plural",
      'Annual Financial Statements for FY2024 is 739 day(s) overdue.',
      /developer's plural/,
    ],
    [
      'a machine timestamp',
      'Extracted at 2026-09-07T06:22:04.572Z.',
      /machine timestamp/,
    ],
    [
      "the table's zero glyph dropped into a sentence",
      'Revenue rose from – to – over 12 periods.',
      /zero glyph where a figure belongs/,
    ],
    [
      'a code identifier that escaped a template',
      'The operatingProfit field was not captured for this period.',
      /camelCase identifier/,
    ],
    [
      'a runtime sentinel',
      'Debtor days is undefined for this period.',
      /placeholder or a runtime sentinel/,
    ],
    [
      // THE UNIT IN A THIRD POSITION. `R'000` heads a column on nine sheets;
      // page 11's headline and page 10's scale note put it immediately after
      // a figure instead, which is a unit a reader has to locate before they
      // can decide whether it applies. `inScale` writes ", in R'000".
      'the column banner shoved against a figure',
      '29 matters require a board decision, 27 of them carrying 3 544 R\'000 of exposure.',
      /unit shoved against a figure/,
    ],
    [
      'the same, on the trends page\'s scale note',
      'The shared y-scale spans (1 621) to 1 908, a span of 3 529 R\'000.',
      /unit shoved against a figure/,
    ],
  ];

  for (const [what, body, expected] of PLANTED) {
    it(`refuses ${what}`, () => {
      const failures = checkProse(withNote(body));
      expect(failures.join('\n')).toMatch(expected);
      // And the message names WHERE, because a gate that says only "the pack
      // leaks" sends the author reading twelve pages.
      expect(failures.join('\n')).toMatch(new RegExp(`page ${clean.pages.length}`));
    });
  }

  it('lets an ordinary sentence through, so the rules are not simply "refuse everything"', () => {
    expect(checkProse(withNote(
      'No account in the chart of accounts is classified as inventory, so the quick ratio and '
      + 'the current ratio are the same number on these figures.',
    ))).toEqual([]);
  });

  it('admits the form the pack actually states its unit in', () => {
    // The other half of the unit rule. It fires on digit-then-banner and must
    // NOT fire on the prose form the pack has used since it had a basis page
    // — otherwise the fix for one sentence refuses the four that were right.
    expect(checkProse(withNote(
      'IFRS for SMEs. 1 January 2026 to 7 September 2026. Figures in R\'000 (ZAR), draft. '
      + '29 matters require a board decision, 27 of them carrying 3 544 of exposure, in R\'000.',
    ))).toEqual([]);
  });
});

describe('checkProse — the composer already passes it', () => {
  const FIXTURES = {
    demo: demoInput,
    brightsphere: brightsphereInput,
    dense: denseInput,
    'no ratio panels': noRatioPanelsInput,
    live: liveDemoInput,
  };

  for (const [name, input] of Object.entries(FIXTURES)) {
    it(`finds nothing to refuse in ${name}`, () => {
      expect(checkProse(buildBoardPackPages(input))).toEqual([]);
    });
  }
});

describe('checkProse — what it deliberately does not read', () => {
  /**
   * A gate over ledger-sourced text would refuse to render a board pack
   * because a bookkeeper named a journal "Item(s) received" — a worse failure
   * than the leak it would catch, and one the customer cannot fix before the
   * meeting. The matters templates are held instead at their source, in
   * `packMatters.test.ts`, where the pack's words and the ledger's are still
   * separable. This pins the exclusion so it stays a decision rather than an
   * oversight in the block walk.
   */
  it('does not refuse a matter whose ledger text would trip a rule', () => {
    const pages = clean.pages.map((page) => {
      const block = page.blocks.find((b) => b.kind === 'matters');
      if (block === undefined || block.kind !== 'matters' || block.matters.length === 0) return page;
      const [first, ...rest] = block.matters;
      return {
        ...page,
        blocks: page.blocks.map((b) => (b === block
          ? {
            ...block,
            matters: [{ ...first!, issue: 'Journal JE-1: item(s) received, account_subtype pending' }, ...rest],
          }
          : b)),
      };
    });
    expect(checkProse({ ...clean, pages })).toEqual([]);
  });
});
