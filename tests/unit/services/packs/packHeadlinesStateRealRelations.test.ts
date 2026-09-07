/**
 * A HEADLINE MAY NOT ASSERT A RELATION THE FIGURES ARE NOT IN, AND THE PACK
 * STATES ITS UNIT IN ONE PLACE.
 *
 * The eleventh visual gate failed the pack on three headlines built from the
 * same construction, in the largest type either sheet sets:
 *
 *   - p-06 demo: "Gross margin is a negative 1310.8%, carrying operating
 *     expenses of 227." A gross margin does not carry operating expenses —
 *     the two are on opposite sides of the gross-profit line, and "carrying"
 *     was doing the work of a comma.
 *   - p-06 Brightsphere: "Revenue of (5 535) carries no meaningful margin
 *     base against operating expenses of (3 717)." The same seam, in the
 *     other branch.
 *   - p-04 against p-11: "the largest carrying 1 869, in R'000 of exposure"
 *     and "27 of them carrying 3 544 of exposure, in R'000" — one clause,
 *     two positions for the unit, on adjacent sheets.
 *
 * All three read as slot-filled strings, which is what a board pack must not
 * read as. These hold the sentences themselves on both companies.
 */
import { describe, expect, it } from 'vitest';
import { incomeStatementTitle, narrativeTitle } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { mattersTitle } from '@/modules/accounting/services/packs/pages/packMattersPage';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import { brightsphereSet, demoSet } from './fixtures/boardPackInputs';
import { liveDemoSet } from './fixtures/liveDemoBoardPack';

const SETS = [
  ['the live demo company', liveDemoSet],
  ['the demo company', demoSet],
  ['Brightsphere', brightsphereSet],
] as const;

describe("page 6's headline", () => {
  for (const [company, set] of SETS) {
    it(`states no relation between the margin and the cost base on ${company}`, () => {
      const title = incomeStatementTitle(set, PACK_SCALE);

      // The two constructions that asserted the relation.
      expect(title, 'the headline claims the margin carries something').not.toMatch(/carr(y|ies|ying)/i);
      expect(title, 'the headline sets one figure "against" another').not.toMatch(/\bagainst\b/i);
      // And the figure the relation was invented for is not in it at all —
      // operating expenses belong to the caption under the same table, which
      // names the line that moved most in money.
      const operating = Math.abs(Math.round(set.current.operatingExpenses / 1_000));
      if (operating > 0) {
        expect(
          title.replace(/[ ]/g, ''),
          'the headline still prints the operating expenses it used to relate the margin to',
        ).not.toContain(String(operating));
      }
    });

    it(`names the denominator the margin was actually computed on, on ${company}`, () => {
      const title = incomeStatementTitle(set, PACK_SCALE);
      // Revenue IS the relation: it is what the percentage was divided by,
      // and it is the figure a reader checks the headline against on the
      // table below it. Present in BOTH branches — the margin branch and the
      // no-meaningful-base branch.
      expect(title, 'the headline names no revenue for a reader to check it against')
        .toMatch(/revenue/i);
    });
  }
});

describe('the exposure clause', () => {
  const matters: PackMatter[] = [
    {
      kind: 'finding', issue: 'A', quantum: 1_869_000, owner: 'x',
      movement: 'y', decisionRequired: 'z',
    },
    {
      kind: 'finding', issue: 'B', quantum: 339_000, owner: 'x',
      movement: 'y', decisionRequired: 'z',
    },
  ];

  /**
   * ONE PLACEMENT, ON BOTH SHEETS. Page 4 put the scale INSIDE the phrase and
   * page 11 put it after it, so the same clause read two ways on facing
   * pages. The unit ends the sentence in both now, which is `inScale`'s own
   * form — and neither may go back to the banner shoved against the figure,
   * which is a third position again.
   */
  it('puts the unit in the same place on page 4 and page 11', () => {
    const page4 = narrativeTitle(matters, 6, PACK_SCALE);
    const page11 = mattersTitle(matters, PACK_SCALE);

    for (const [where, title] of [['page 4', page4], ['page 11', page11]] as const) {
      expect(title, `${where} does not state the exposure's unit`).toContain(`, in ${PACK_SCALE}`);
      // The unit ENDS the clause: nothing but a full stop follows it.
      expect(title, `${where} interrupts its own phrase with the unit`)
        .toMatch(new RegExp(`, in ${PACK_SCALE.replace(/'/g, "'")}\\.?$`));
      // And never the banner token hard against a figure.
      expect(title, `${where} sets the banner against a figure`).not.toMatch(/\d\s*R'000/);
    }
  });
});
