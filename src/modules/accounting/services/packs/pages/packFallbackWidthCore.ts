/**
 * HOW THE FALLBACK TABLES ARE READ, for any one table (`packFallbackWidth.ts` has the rules; this is them, over a table
 * the caller holds). Split out so the commentary gate (`packProseBound`) can read the one style it needs
 * (`packProseFallbackData`, the regular label table) without loading every style into the editor (#1263 L2).
 * Client-safe: arithmetic and data only.
 */
import { FALLBACK_MARKS } from './packFallbackMarkData';
import { ANY_BASES, SCRIPT_NAMES, SCRIPT_RANGES } from './packFallbackScriptData';
import type { FallbackTable } from './packFallbackWidthData';

const BLOCK = 32;
/**
 * Joiners, selectors and the marks that do not space (Mn, Me) add nothing to the glyph they join or select. A SPACING
 * mark (Mc: the Myanmar, Khmer and Indic vowel signs and medials) takes room of its own, and costs its own advance: at
 * nothing, Burmese prose read 18% narrower than production sets it (#1263 round 2).
 */
const ADDS_NOTHING = /^[\p{Mn}\p{Me}\u200C\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;

function exactIndex(cp: number, ranges: ReadonlyArray<readonly [number, number]>): number {
  let offset = 0;
  for (const [from, to] of ranges) {
    if (cp >= from && cp <= to) return offset + cp - from;
    offset += to - from + 1;
  }
  return -1;
}

/** One code point's advance in whole pixels in `table` (its per-glyph `ranges`), at the size it is measured at. */
export function fallbackAdvanceIn(table: FallbackTable, ranges: ReadonlyArray<readonly [number, number]>, cp: number): number {
  const ch = String.fromCodePoint(cp);
  if (ADDS_NOTHING.test(ch)) return 0;
  const at = exactIndex(cp, ranges);
  let px: number;
  if (at >= 0) px = table.wide[cp] ?? Number.parseInt(table.exact[at]!, 36);
  else {
    const block = Math.floor(cp / BLOCK);
    px = block < table.blocks.length ? table.wide[block * BLOCK] ?? Number.parseInt(table.blocks[block]!, 36) : table.widest;
  }
  return px === 0 ? table.widest : px;
}

/** What each combining mark the faces lack adds, measured in production's image: [in a word, elsewhere, script]. */
const MARKS = new Map<number, readonly [number, number, number]>(FALLBACK_MARKS.map(([cp, inWord, elsewhere, script]) => [cp, [inWord, elsewhere, script]]));
/** The scripts whose marks go on any letter (Common, Inherited), and the letters they were measured on. */
const ANY = new Set(SCRIPT_NAMES.flatMap((name, i) => (name === 'Common' || name === 'Inherited' ? [i] : [])));
const ANY_BASE = new Set(ANY_BASES);
const MARK = /^\p{M}$/u;
const SELECTOR = /^[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
/** The text (U+FE0E) and emoji (U+FE0F) presentation selectors. */
const PRESENTATION = /^[\uFE0E\uFE0F]$/u;
/** A pictograph and its emoji selector, and nothing else: one emoji. */
const PICTOGRAPH_SELECTED = /^\p{Extended_Pictographic}\uFE0F$/u;
/** A joiner, a selector or any other format character: a code point that is nothing a mark was measured after. */
const IGNORABLE = /^[\p{Cf}\p{Default_Ignorable_Code_Point}]$/u;
/** What makes a cluster an emoji sequence: a ZWJ, an emoji modifier, a text or emoji selector, a keycap or a tag character. */
const EMOJI_SEQUENCE = /[\u200D\u{1F3FB}-\u{1F3FF}\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/u;
/** A keycap, or a digit, "#" or "*" with U+FE0F alone. */
const KEYCAP = /^[0-9#*](?:\uFE0F?\u20E3|\uFE0F)$/u;

/** The script (an index into `packFallbackScriptData.SCRIPT_NAMES`) `cp` is a measured base of; -1 for any other. */
function scriptAt(cp: number): number {
  let lo = 0;
  let hi = SCRIPT_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to, script] = SCRIPT_RANGES[mid]!;
    if (cp < from) hi = mid - 1;
    else if (cp > to) lo = mid + 1;
    else return script;
  }
  return -1;
}

/**
 * A cluster's cost in `table` at the size it is measured at (`measuredPx`), scaled to `sizePx` and rounded up. A mark of
 * a script the faces lack costs what it adds in production's image (`packFallbackMarkData`), not its general
 * category's guess or its advance alone: after a letter of its own script, what it adds in a word; after itself, what it
 * adds there; after anything else, the widest glyph (#1263 round 3: "m" or a Myanmar digit with a Myanmar vowel sign, a
 * Khmer vowel sign three times over, Lao U+0ECE; and an Indic vowel sign, which alone costs half again what it adds in a
 * word: Hindi read 16 lines to production's 11). By `marks`, which prose and the gate set: a row label holding a mark is
 * printed to break anywhere and priced apart (`packAnywhereLabel`), and keeps the tables' reading.
 */
export function fallbackClusterIn(
  table: FallbackTable, ranges: ReadonlyArray<readonly [number, number]>, cluster: string, sizePx: number, measuredPx: number, marks = false,
): number {
  let px = 0;
  const cps = Array.from(cluster);
  // A keycap, or a digit, "#" or "*" with U+FE0F, is one emoji: 14.98px at 12px in production's image, wherever it stands.
  if (marks && KEYCAP.test(cluster)) return Math.ceil((Math.max(fallbackAdvanceIn(table, ranges, cps[0]!.codePointAt(0)!), table.emoji) * sizePx) / measuredPx);
  // A mark is priced as written only on a base it was measured on (`packFallbackMarkData`: a consonant of its own
  // script, or for a Common or Inherited mark the letters of ANY_BASES), and once in its cluster; on anything else, a
  // second time, or not in the table at all, the print may set it on a dotted circle in a face of its own, wider than
  // any table here measures: it costs the widest fallback glyph (#1263 rounds 3 and 4). A selector adds what it was
  // measured to add on any base.
  const base = cps[0] === undefined ? -1 : cps[0].codePointAt(0)!;
  const seen = new Set<number>();
  // The marks (selectors apart) unbroken just before this code point.
  let run = 0;
  cps.forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    const mark = marks ? MARKS.get(cp) : undefined;
    const prev = i > 0 ? cps[i - 1]! : '';
    const selector = SELECTOR.test(ch);
    const inRun = run;
    run = MARK.test(ch) && !selector ? run + 1 : 0;
    if (mark === undefined) {
      px += marks && i > 0 && MARK.test(ch) ? table.widest : fallbackAdvanceIn(table, ranges, cp);
      return;
    }
    // Only the contexts measured are priced as measured (#1263 round 5): a mark right after its base or after one
    // mark. After a joiner, a selector, a format character, or as the third mark of a run, production sets the
    // sequence on a dotted circle or a stack in a face of its own: the widest glyph. A selector is a mark of Common
    // or Inherited script, measured on the letters of ANY_BASES only (#1264 round 6: after a base the faces lack, such
    // as U+022E or a Myanmar digit, production sets base and selector wider): on any other base, the widest glyph.
    const unmeasured = i > 0 && (selector ? MARK.test(prev) || IGNORABLE.test(prev) : IGNORABLE.test(prev) || inRun >= 2);
    // An emoji selector (U+FE0F only) right after a pictograph is one emoji in the print, which the emoji floor below
    // prices: it adds nothing of its own (#1264 round 6, owner: ordinary text is full of "\u2764\uFE0F"). U+FE0E is not
    // free (U+1F634 U+FE0E is 19px: the sequence rule below), nor are VS1 to VS14 and the ideographic selectors (round 7).
    const onPictograph = selector && PRESENTATION.test(ch) && PICTOGRAPH.test(prev);
    const writtenOn = i > 0 && !unmeasured && (onPictograph || (ANY.has(mark[2]) ? ANY_BASE.has(base) : scriptAt(base) === mark[2]));
    // After another mark (a second sign on one consonant), the order may be one the shaper rejects (Devanagari
    // anusvara before vowel sign I, Burmese U typed before I), set on a dotted circle: the larger of what it adds in a
    // word and elsewhere (#1263 round 4), and at least the circle itself, an em (round 5: Lao and Odia pairs the table
    // reads at nothing print a line in eight wider).
    let cost = seen.has(cp) ? mark[1] : inRun > 0 ? Math.max(mark[0], mark[1]) : mark[0];
    if (inRun > 0) cost = Math.max(cost, measuredPx);
    px += writtenOn ? cost : table.widest;
    seen.add(cp);
  });
  // An emoji sequence that is not a pictograph with U+FE0F (#1264 round 7, after six rounds of sequences): production draws
  // a ZWJ, modifier, keycap or tag sequence as one glyph only if it has one, and as its components otherwise, each an
  // emoji or its own glyph, a neighbour of a ZWJ drawn in the emoji face (a digit, "#", U+2640 after a letter) and a
  // modifier on a base that takes none as a swatch of its own. Which is not known here, so every code point costs at
  // least an emoji: never less than the cluster's own price.
  if (marks && EMOJI_SEQUENCE.test(cluster) && !PICTOGRAPH_SELECTED.test(cluster)) {
    px = Math.max(px, cps.reduce((sum, ch) => sum + Math.max(fallbackAdvanceIn(table, ranges, ch.codePointAt(0)!), table.emoji), 0));
  }
  // A pictograph is drawn in the emoji face, the width of an emoji whatever its own advance, wherever a lone modifier or
  // regional indicator stands before it in the text (a skin tone, a space and U+2764 print 32.78px; U+2764 alone 10px).
  if (marks && PICTOGRAPH.test(cps[0] ?? '')) px = Math.max(px, table.emoji);
  if (/[\uFE0F\u20E3]/u.test(cluster)) px = Math.max(px, table.emoji);
  return Math.ceil((px * sizePx) / measuredPx);
}
