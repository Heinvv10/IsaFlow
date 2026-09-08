/**
 * BOTH COVERS STATE THE PART MONTH, FROM THE SAME RULE.
 *
 * The demo cover said the pack is a draft because "the fiscal period it ends
 * in is still open, so these figures can still move"; Brightsphere's, whose
 * September period IS closed in the ledger, correctly dropped that clause —
 * and so the Brightsphere reader was never told anywhere on the front of the
 * pack that the figures stop on the seventh of a thirty-day month. The
 * eleventh gate read the two covers side by side and could not tell which
 * fact each was reporting.
 *
 * The fix is NOT to drive "figures can still move" off the part month: a
 * closed period means the posted figures will not move, so that sentence
 * would be false on Brightsphere. The part month is a different fact, and it
 * is stated as itself, from `partialMonthClauseFor` — the pack's one wording
 * — on every cover whose series ends on a stub, whatever the draft reasons
 * are.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { partialMonthOf } from '@/modules/accounting/services/packs/pages/packPartialMonth';
import { brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['the live demo company', liveDemoRenderedInput],
  ['the demo company', demoInput],
  ['Brightsphere', brightsphereLiveInput],
];

/** Every word on the cover, whatever block carries it. */
function coverText(input: BoardPackInput): string {
  const cover = buildBoardPackPages(input).pages[0]!;
  return cover.blocks
    .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => `${n.heading} ${n.body}`) : []))
    .join(' ');
}

describe('the cover', () => {
  it.each(FIXTURES)('states the part month on %s', (name, input) => {
    const point = partialMonthOf(input.trend);
    if (point === null) {
      // A whole-month series must not carry the clause — a caveat has to
      // qualify something the pack prints.
      expect(coverText(input)).not.toMatch(/part month/i);
      return;
    }
    const text = coverText(input);
    expect(text, 'the cover never says the period stops mid-month').toMatch(/part month/i);
    // The fraction, not just the words — "7 of its 30 days" is what a reader
    // needs, and it comes from the trend rather than from a literal.
    expect(text).toContain(`${point.daysCovered} of its ${point.daysInMonth} days`);
  });

  /**
   * AND IT IS NOT THE DRAFT SENTENCE DOING IT. Brightsphere's period is
   * CLOSED, so it carries no `openPeriod` reason and its cover has no
   * "figures can still move" clause — and it must still state the part month.
   * Drive the clause off the draft reasons instead and this goes red.
   */
  /**
   * AND THE OPEN-PERIOD CLAUSE IS DERIVED, WHICH IS WHY THE TWO PACKS DIFFER.
   *
   * The demo's cover carries "the fiscal period it ends in is still open, so
   * these figures can still move" and Brightsphere's does not, for an
   * identical period end — which reads as one convention applied to half the
   * pack until you look at where it comes from. Both go through one function
   * of `(companyId, reportingDate)`: `getPeriodStatusForDate` reads
   * `fiscal_periods.status`, and on 2026-09-07 the demo's September 2026 is
   * `open` while Brightsphere's is `closed` (verified against the dev
   * database, not production). The difference is in the books.
   *
   * Held here at the COMPOSED document rather than at `draftReasons`, because
   * the question was never whether the reason is computed correctly — it is
   * whether the cover says what the reasons say.
   */
  it('says figures can still move exactly where the period is open', () => {
    for (const [name, input] of [
      ['the demo company', liveDemoRenderedInput],
      ['Brightsphere', brightsphereLiveInput],
    ] as const) {
      const open = input.draftReasons.includes('openPeriod');
      expect(
        /can still move/.test(coverText(input)),
        open
          ? `${name}'s period is open and its cover does not say the figures can move`
          : `${name}'s period is not open and its cover says the figures can move`,
      ).toBe(open);
    }
  });

  it('states it on a pack whose fiscal period is closed', () => {
    const closed: BoardPackInput = {
      ...liveDemoRenderedInput,
      draftReasons: ['unapprovedCommentary'],
    };
    const text = coverText(closed);
    expect(text, 'the cover claims figures can still move on a closed period')
      .not.toMatch(/can still move/);
    expect(text, 'a closed-period pack never tells its reader the period stops mid-month')
      .toMatch(/part month/i);
  });
});
