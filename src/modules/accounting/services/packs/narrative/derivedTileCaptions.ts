/**
 * The highlight tile's derived line — its movement in words, and the one
 * statement the pack makes where there is no movement to show. Moved out of
 * `derivedCaptions.ts` unchanged to keep that file under the 300-line cap;
 * `derivedCaptions.ts` re-exports every exported name here.
 */

import { formatPctLevel, pctWithWord } from '@/lib/format/money';
import type {
  PackKpiDelta,
  PackKpiDeltaAbsence,
  PackKpiTile,
} from '@/modules/accounting/services/packs/pages/packPageModel';

/**
 * A TILE'S MOVEMENT IN WORDS — "up 12.0%", or "up 3.0 points" where the
 * figure is itself a percentage. See `PackKpiDelta.unit`.
 *
 * One function for the tile and its caption, so the two cannot state one
 * movement in two units three centimetres apart. `up` and `down` are both
 * required for the reason `pctWithWord` gives: the sign is carried by a word.
 */
export function deltaWithWord(
  delta: PackKpiDelta,
  up: string,
  down: string,
  /**
   * How the unit is spelt. A sentence says "points"; the TILE passes `pp`,
   * because its delta line is set across a quarter of the measure and has no
   * room for the word — "up 1.0 points prior period" takes a second line,
   * 4.2mm on a sheet that composes within half a millimetre of its box.
   */
  points: 'points' | 'pp' = 'points',
): string {
  if (delta.unit === 'percent') return pctWithWord(delta.value, up, down);
  // The magnitude through the pack's own percentage formatter, less its sign:
  // "1 310.8", grouped as every other figure on the sheet is. `toFixed` here
  // printed "1310.8 pp" beside a tile reading "1 310.8%".
  const magnitude = formatPctLevel(Math.abs(delta.value)).replace('%', '');
  return `${delta.value < 0 ? down : up} ${magnitude} ${points}`;
}

/**
 * One derived line per highlight tile — spec §4.A page 3's "derived one-liner
 * per tile".
 *
 * It carries no formatted figure on purpose: the tile prints the value itself
 * three centimetres away, and a second rendering of the same number here is
 * how a pack ends up disagreeing with itself over rounding. What the tile
 * cannot say is the DIRECTION's meaning, which is what this adds. That is
 * also why it takes no scale — there is nothing here to scale.
 */
export function tileCaption(tile: PackKpiTile): string {
  if (tile.figure.value === null) {
    return `Not available. ${tile.figure.unavailable ?? ''}`.trim();
  }
  if (tile.delta === null) {
    // REFUSED, NOT DEFAULTED. `PackKpiTile` states that exactly one of `delta`
    // and `deltaAbsence` is non-null, and this used to spell the missing half
    // `?? 'noCurrentValue'` — which prints "This tile has no figure for the
    // period, so there is nothing to move" under a tile that has just printed
    // its figure, because the branch above already returned for a null one.
    // A caption that is false on a board pack is worse than a render that
    // stops, and a fallback is how an invariant stops being one.
    if (tile.deltaAbsence === null) {
      throw new Error(
        `tileCaption: "${tile.label}" shows no movement and states no reason. Exactly one of `
          + 'delta and deltaAbsence must be set; refusing to print a reason this tile did not give.',
      );
    }
    return DELTA_ABSENCE[tile.deltaAbsence];
  }
  const judgement = tile.delta.favourable ? 'a favourable' : 'an unfavourable';
  return `${deltaWithWord(tile.delta, 'Up', 'Down')} on the ${tile.delta.basis} — ${judgement} movement.`;
}

/**
 * The pack's ONE comparative statement, per reason — see
 * `PackKpiDeltaAbsence`, which is where the reasons are distinguished.
 *
 * Every one of these used to be the first line: "No comparative period, so no
 * movement is shown against this figure.", printed seven times on sheet 3 of
 * a pack whose sheets 5, 6, 7 and 8 carried a prior column and whose sheet 12
 * named the comparative's dates. `unusableBase` is worded in the same terms
 * as `NOT_A_POSITIVE_BASE`, the statement tables' own n/m footnote, so a tile
 * and the table two sheets later say one thing about one figure.
 *
 * A `Record` keyed by the union, so adding a reason is a compile error here
 * rather than a tile that silently prints the wrong one — which is the defect
 * this replaces.
 */
export const NOT_A_POSITIVE_BASE =
  'The prior figure is not a positive base, so no percentage change is meaningful.';

const DELTA_ABSENCE: Record<PackKpiDeltaAbsence, string> = {
  noComparativePeriod: 'No comparative period, so no movement is shown against this figure.',
  noPriorValue: 'The comparative period carries no value for this measure, so no movement is shown.',
  unusableBase: NOT_A_POSITIVE_BASE,
  noCurrentValue: 'This figure is not available for the period, so there is no movement to show.',
};
