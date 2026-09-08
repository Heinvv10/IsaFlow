/**
 * A PANEL THAT STARTS LATE, AND THE RULE THE PACK HAD FOR ONLY HALF OF IT.
 *
 * Page 10 draws six small multiples over the same twelve-month window, and on
 * the live demo pack two of them do not: gross margin and debtor days run
 * Jul 2026 to Sep 2026 (part), three periods of twelve, because revenue is
 * nil before July and neither ratio is defined without it. `ratioPanel` drops
 * the months it cannot measure rather than plotting a false zero, which is
 * the right behaviour — a gap in a series is honest and a zero is a claim
 * about a debtor book that collected nothing.
 *
 * The pack stated the OTHER half of that rule and not this one. Brightsphere
 * carries `Panels not drawn`: "A panel is omitted when its figure is not
 * meaningful in every period of the window", and all four of its drawn panels
 * are twelve periods — so its copy of page 5's window sentence was true, and
 * that is why the claim survived fourteen gates. One company omits, the other
 * shortens, and only the omission had a rule printed beside it.
 *
 * SHORTENING IS KEPT RATHER THAN CONVERTED TO OMISSION. A gross margin over
 * the three months in which revenue exists is a real measurement, and
 * dropping two drawn panels to make a sentence true removes content a board
 * can use in order to fix a sentence. The two behaviours are one rule as soon
 * as both halves are stated: omit where the measure exists NOWHERE in the
 * window, shorten where it exists in PART of it.
 *
 * IT IS ON PAGE 4, AND PAGE 10 WAS MEASURED FIRST. This belongs where the
 * reader meets the panel, and page 10 has no paper: it composes at 252.47mm
 * of a 255mm sheet on `liveDemoRendered` — 2.53mm against a disclosure block
 * of six or more — and `fitPageToBox` answers an overflow there by dropping
 * the Scale and Period notes, so the page would buy this rule by apologising
 * for its own layout and losing the month-versus-period reconciliation. Page
 * 5's window note, where the false claim was, has ten to fourteen characters
 * of slack and a line costs 4.94mm. Page 12's tightest fixture has 2.59mm.
 * Page 4 is prose by §4.A, is the first sheet a board reads, and carries the
 * pack's other two how-to-read-these-figures disclosures.
 *
 * What the reader meets on page 10 is not silent in the meantime: each
 * shortened panel's own title states its period count — "over 3 periods" —
 * so the fact is where the panel is and the RULE is where there is room to
 * state it.
 *
 * IT NAMES THE PANELS. "Some panels cover fewer months" would send a director
 * to compare six titles; the two that do are named, off the same `pick` the
 * panels are drawn from, so this note cannot name a panel whose title says
 * twelve.
 */
import { mustDisclose, note } from './packPageBlocks';
import type { PackPageBlock } from './packPageModel';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/**
 * THE OMISSION HALF OF THE RULE, WRITTEN ONCE.
 *
 * "A panel is omitted when its figure is not meaningful in every period of
 * the window" reads two ways — "not (meaningful in every period)", which is
 * the demo's shortened gross-margin panel and would make the sentence
 * contradict a panel three centimetres above it, and "(not meaningful) in
 * every period", which is what it means. The negation is what does it: move
 * it onto the quantifier and the sentence has one reading.
 *
 * It is a CONSTANT because the pack states this rule on two different sheets
 * — page 10 when a panel is absent, page 4 when one starts late — and those
 * two are halves of a single rule: omit where the measure exists nowhere in
 * the window, shorten where it exists in part of it. Stated twice in two
 * wordings, one of them was loose and nothing could notice; stated once, a
 * reader meeting either sheet gets the same sentence.
 */
export const PANEL_OMITTED_RULE =
  'A panel is omitted where its figure is meaningful in no period of the window';

/** The heading the note prints under. */
export const SHORTENED_PANELS_HEADING = 'Panels that cover part of the window';

/** Names joined as a sentence fragment. */
function inWords(names: readonly string[]): string {
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}

/**
 * The rule for a panel drawn over part of the window, or null where every
 * drawn panel covers all of it — which is most packs, and is Brightsphere.
 *
 * @param shortened `TrendPanels.shortenedPanels` — drawn panels plotting
 *   fewer months than the window, by name.
 * @param trend The window itself, for the count the note states.
 */
export function shortenedPanelsNote(
  shortened: readonly string[],
  trend: readonly PackTrendPoint[],
): PackPageBlock | null {
  if (shortened.length === 0 || trend.length === 0) return null;
  const isOne = shortened.length === 1;
  return mustDisclose(SHORTENED_PANELS_HEADING, [
    note('Why some panels are shorter',
      `${inWords(shortened)} ${isOne ? 'is' : 'are'} drawn over fewer than the `
      + `${trend.length} months the trends page covers. A ratio is not measured in a month `
      + `whose base is nil, so ${isOne ? 'that panel starts' : 'those panels start'} at the `
      + `first month ${isOne ? 'it' : 'they'} can be measured rather than being plotted as a `
      + `zero, and ${isOne ? 'its own title' : "each panel's own title"} states how many periods `
      + `it covers. ${PANEL_OMITTED_RULE}, and the trends page says so where that happens.`),
  ]);
}
