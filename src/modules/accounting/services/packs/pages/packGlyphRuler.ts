/**
 * THE WIDTH OF A RUN OF TEXT IN THE PACK'S OWN FACE, AS PRODUCTION'S CHROMIUM SETS IT.
 *
 * Production prints through Gotenberg, whose Chromium positions glyphs at fractional advances
 * (`tests/unit/print/printChromium.ts`). For a run in the self-hosted IBM Plex Sans faces it sets the font at its size
 * floored to 1/64px, shapes each run of one script on its own with the face's own features (pair kerning, ligatures,
 * and the `tnum` and `lnum` every pack position asks for), and rounds the line's width UP to its 1/64px layout unit.
 * This shapes the same woff2 files the print stylesheet serves (`public/fonts`), so a font update moves it with the
 * print. Measured against Chromium (`packGlyphRuler.test.ts`): never short, at most 1/32px over (one 1/64 unit is
 * added: Chromium sums advances in single precision and lands a unit either side of the exact sum).
 *
 * A cluster the faces have no glyph for is set in the render host's fallback fonts: the caller says what it costs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { asShaped, shapingInput } from './packGlyphShaping';

export type FaceWeight = 400 | 500 | 600;

export const FILES: Readonly<Record<FaceWeight, string>> = {
  400: 'IBMPlexSans-Regular.woff2', 500: 'IBMPlexSans-Medium.woff2', 600: 'IBMPlexSans-SemiBold.woff2',
};
/** What `html.print-mode body` asks of every run (`packPrintPage.css`). */
const FEATURES = ['tnum', 'lnum'];
const UNIT = 64;

type Face = fontkit.Font;

const faces = new Map<FaceWeight, Face>();

/**
 * The face of `weight` from `dir`. A face that cannot be read is an error, said out loud: the fit refuses to guess a
 * width (there is no per-character table to fall back to), and a pack is not composed without it.
 */
export function loadFace(dir: string, weight: FaceWeight): Face {
  const file = path.join(dir, FILES[weight]);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    throw new Error(`packGlyphRuler: cannot read the pack's face ${file}; the figure fit refuses to guess a width (${err instanceof Error ? err.message : String(err)})`);
  }
  return fontkit.create(bytes);
}

/**
 * The faces the print stylesheet serves: `public/fonts` under the working directory, which is the repository in a test
 * and the colour's release folder in production (the standalone server runs there, and the deploy copies `public/`
 * beside it: `scripts/deploy/bluegreen.sh`).
 */
export const fontsDir = (): string => path.join(process.cwd(), 'public', 'fonts');

/** The face of `weight`, read once and kept. */
function face(weight: FaceWeight): Face {
  let f = faces.get(weight);
  if (f === undefined) {
    f = loadFace(fontsDir(), weight);
    faces.set(weight, f);
  }
  return f;
}

/** Does the pack's own face have a glyph for every code point of `cluster` (its marks and selectors included)? */
export function inFace(cluster: string): boolean {
  const f = face(400);
  return Array.from(cluster).every((ch) => f.hasGlyphForCodePoint(ch.codePointAt(0)!));
}

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });
export const clustersOf = (text: string): string[] => Array.from(SEGMENTER.segment(text), (s) => s.segment);

const FACE_SCRIPTS = ['Latin', 'Greek', 'Cyrillic'] as const;
const SCRIPT_SETS = new Map<string, readonly string[] | null>();

/**
 * The scripts a character can be shaped in, as Chromium's run segmenter reads them (ICU's, with Unicode's Script
 * Extensions): its own script; null for a common or inherited character that goes with any run; and for a common
 * character whose Script Extensions name scripts (the middle dot, U+00B7: Latin, Greek and others; the modifier
 * apostrophe, U+02BC: Latin, Cyrillic and others; the narrow no-break space, U+202F: Latin and Mongolian), those of
 * the faces' scripts it names, and 'Other' for the rest. A character the faces have outside them is 'Other'.
 */
function scriptSetOf(ch: string): readonly string[] | null {
  const known = SCRIPT_SETS.get(ch);
  if (known !== undefined) return known;
  let set: readonly string[] | null;
  const own = FACE_SCRIPTS.find((script) => new RegExp(`\\p{Script=${script}}`, 'u').test(ch));
  if (own !== undefined) set = [own];
  else if (/\p{Script=Inherited}/u.test(ch) || /[\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]/u.test(ch)) set = null;
  else if (/\p{Script=Common}/u.test(ch)) set = [...FACE_SCRIPTS.filter((script) => new RegExp(`\\p{Script_Extensions=${script}}`, 'u').test(ch)), 'Other'];
  else set = ['Other'];
  SCRIPT_SETS.set(ch, set);
  return set;
}

/**
 * `text` cut into the runs Chromium shapes apart (and so kerns nothing across): a run carries the scripts every
 * character in it can be shaped in; a character that leaves none (a Cyrillic letter after a middle dot, which Unicode
 * gives Latin and Greek but not Cyrillic) starts the next run. A common character goes with the run it stands in, but a
 * closing bracket goes with its opening bracket's ("(13 Җ)": the ")" is Latin, as the "(" was, and ends the Cyrillic run).
 * Measured: "·⁵Ј" is 910 units in Chromium, not the 876 one run kerned "⁵Ј" would make (`packGlyphRuler.test.ts`).
 */
export function scriptRuns(text: string): string[] {
  type Run = { scripts: readonly string[] | null; text: string };
  const runs: Run[] = [];
  // Open brackets, each with the run it opened in, at most `MAX_BRACKETS` (the oldest dropped past it). A closing
  // bracket is shaped in its opener's script: the nearest opener of its kind, the brackets above it popped and the
  // opener itself kept, as Chromium's ScriptRunIterator does ("x(Ж(Ж)Т)": the last ")" meets the inner "(" again,
  // and stays Cyrillic). The search is from the top and bounded by the cap, so a line costs linear time however many
  // brackets it holds.
  const open: Array<{ close: string; run: Run }> = [];
  for (const ch of text) {
    let scripts = scriptSetOf(ch);
    for (let at = open.length - 1; at >= 0; at -= 1) {
      if (open[at]!.close !== ch) continue;
      scripts = open[at]!.run.scripts;
      open.length = at + 1;
      break;
    }
    const last = runs[runs.length - 1];
    if (last === undefined) runs.push({ scripts, text: ch });
    else if (scripts === null) last.text += ch;
    else {
      const shared = last.scripts === null ? scripts : last.scripts.filter((s) => scripts!.includes(s));
      if (shared.length > 0) { last.scripts = shared; last.text += ch; } else runs.push({ scripts, text: ch });
    }
    const closer = BRACKETS[ch];
    if (closer !== undefined) {
      open.push({ close: closer, run: runs[runs.length - 1]! });
      if (open.length > MAX_BRACKETS) open.shift();
    }
  }
  return runs.map((r) => r.text);
}

/** How many open brackets Chromium's ScriptRunIterator keeps (`kMaxBrackets`): past it the oldest is dropped. */
const MAX_BRACKETS = 32;

/** The paired brackets the faces set (Unicode's Bidi_Paired_Bracket): each opener and its closer. */
const BRACKETS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '\u207D': '\u207E', '\u208D': '\u208E' };

/**
 * How a width is rounded to Chromium's unit: `NEVER_SHORT` (the exact sum rounded up, and one unit more) for a decision
 * that must never be short (does a row fit the sheet?); `AS_CHROMIUM_SETS` (rounded up, no unit added) for a layout
 * model that reproduces Chromium's columns (`packTableLayout.ts`); `CHROMIUM_LEAST` and `CHROMIUM_MOST`, the narrowest
 * and widest Chromium can set it once its own float noise on a single run (`RUN_NOISE_UNITS`) is counted either way: the bounds a
 * model takes a column at when it must be no wider (or no narrower) than Chromium's (`packKpiLayout.kpiColumnBoundsPx`).
 * An argument, never a setting: a measure in flight cannot change another's.
 */
export type Slack = 0 | 1 | 'least' | 'most';
export const NEVER_SHORT: Slack = 1;
export const AS_CHROMIUM_SETS: Slack = 0;
export const CHROMIUM_LEAST: Slack = 'least';
export const CHROMIUM_MOST: Slack = 'most';

/** Runs already shaped: their advance in font units, by weight and text (a pack shapes the same words many times). */
const SHAPED = new Map<string, number>();
const SHAPED_MAX = 50_000;

function unitsOf(f: Face, weight: FaceWeight, run: string): number {
  const key = `${weight}|${run}`;
  let units = SHAPED.get(key);
  if (units === undefined) {
    units = 0;
    for (const p of f.layout(shapingInput(f, run), FEATURES).positions) units += p.xAdvance;
    if (SHAPED.size >= SHAPED_MAX) SHAPED.clear();
    SHAPED.set(key, units);
  }
  return units;
}

/** The size Chromium sets a font at: floored to its 1/64px unit. */
export const setSizePx = (fontPx: number): number => Math.floor(fontPx * UNIT + 1e-9) / UNIT;

/**
 * The width of `text` at `fontPx` and `weight`, in CSS pixels on Chromium's 1/64 grid, never short.
 * `fallbackPx(cluster, sizePx)` prices a cluster outside the face (`sizePx` is the size the font is set at);
 * `letterSpacingPx` is added after every cluster, the last included (CSS `letter-spacing`). `hyphen`: the line ends at a
 * soft hyphen in `text`, and Chromium sets a hyphen (U+2010, shaped on its own) after it, a box of its own rounded to
 * the unit on its own (`hyphenExactPx`; measured: "growth\u00AD" has a min-content of 2713/64px, the word's 2406 and
 * the hyphen's 307, not the 2712 of the two summed). `slack`: see `Slack`.
 */
export function runPx(
  text: string, fontPx: number, weight: FaceWeight, fallbackPx: (cluster: string, sizePx: number) => number, letterSpacingPx = 0,
  hyphen = false, slack: Slack = NEVER_SHORT,
): number {
  if (text === '' && !hyphen) return 0;
  const round = (exactPx: number): number => {
    const exact = exactPx * UNIT;
    if (slack === 'least') return Math.ceil(exact - RUN_NOISE_UNITS);
    if (slack === 'most') return Math.ceil(exact + RUN_NOISE_UNITS);
    return Math.ceil(exact - 1e-7);
  };
  const units = (text === '' ? 0 : round(runExactPx(text, fontPx, weight, fallbackPx, letterSpacingPx))) + (hyphen ? round(hyphenExactPx(fontPx, weight)) : 0);
  return (units + (typeof slack === 'number' ? slack : 0)) / UNIT;
}

/** The exact advance of the hyphen (U+2010) Chromium sets at a soft hyphen that ends a line, at `fontPx` and `weight`. */
export function hyphenExactPx(fontPx: number, weight: FaceWeight): number {
  const f = face(weight);
  return unitsOf(f, weight, '\u2010') * setSizePx(fontPx) / f.unitsPerEm;
}

/**
 * The exact advance sum of `text` (`runPx`'s arguments), not rounded to any unit: what a line FITS by. Chromium's line
 * breaker keeps a run on a line where its width, floored to the 1/64px unit, is no wider than the room left
 * (`fitUnitsPx`); measured on the 630-case grid and the ruler's random strings, and on a KPI label with its mark and a
 * delta line with its cue (`tests/unit/print/packLineFit.test.ts`). A width a column is SIZED by stays `runPx`'s.
 * `hyphen`: a soft hyphen's hyphen after it, which is a box of its own on the line, so it is added at the width Chromium
 * sets that box (its exact advance rounded up to the unit: one glyph, whose float noise is far under the 0.032 of a unit
 * the pack's closest, 12px/500's 307.968, leaves), not summed exactly: the line's floor cannot take any of it back
 * (measured: "Gross margin\u00AD" needs 4852/64px on one line, its words floored and the hyphen's 307; the hyphen summed
 * exactly with them fitted it at 4851).
 */
export function runExactPx(
  text: string, fontPx: number, weight: FaceWeight, fallbackPx: (cluster: string, sizePx: number) => number, letterSpacingPx = 0,
  hyphen = false,
): number {
  const f = face(weight);
  const size = setSizePx(fontPx);
  let units = 0;
  let px = 0;
  let inside = '';
  const flush = (): void => {
    for (const run of scriptRuns(inside)) units += unitsOf(f, weight, run);
    inside = '';
  };
  // What Chromium sets as nothing (a soft hyphen, a zero-width space, a word joiner, ...) out, kerned across; a line or
  // paragraph separator as a space; a fraction slash decided on the text as given (`packGlyphShaping.asShaped`).
  for (const cluster of clustersOf(asShaped(text))) {
    px += letterSpacingPx;
    if (inFace(cluster)) inside += cluster;
    else { flush(); px += fallbackPx(cluster, size); }
  }
  flush();
  if (hyphen) px += Math.ceil(hyphenExactPx(fontPx, weight) * UNIT - 1e-7) / UNIT;
  return units * size / f.unitsPerEm + px;
}

/**
 * HOW FAR CHROMIUM'S OWN SUM OF A LINE CAN RUN PAST THE EXACT ONE, in units: the margin added before flooring, so a line
 * the model fits, Chromium fits (`fitMarginUnits`). Measured as the narrowest one-line width less the line's exact sum
 * (`packLineFit.test.ts` holds every set): a single run of 1 to 14 glyphs within 0.045 of a unit, a label with its mark
 * 0.056, a delta line with its cue 0.192. It GROWS with the line, Chromium's float noise gathering glyph by glyph, so
 * with the glyphs a line holds: the measure is the line's width at 12px, `exactPx` x (12 / `fontPx`)^2 (a smaller face
 * sets more glyphs a pixel; the square is what the sizes measured). Over 21,331 lines of 100 to 1,800px
 * (`fixtures/lineFitLongLines.ts`: 17,996 random, 3,335 of one glyph repeated, the narrow ones furthest) it reached 0.34
 * to 512px, 0.71 to 1,000px and 1.39 at 1,741px ("fff..." at 10.67px/500). So the margin is half a unit to
 * `FIT_NOISE_FLAT_PX` (where the KPI and table grids proved the fit) and grows by a unit for every
 * `FIT_NOISE_PX_PER_UNIT` past it: at least 0.085 of a unit over the worst seen at every width to 1,000px (no column
 * the pack sets a line in is wider than `PRINT_CONTENT_PX`'s 987px): 0.085 for a 10.67px run of one narrow glyph at
 * 899px, 0.135 for the 12px lines ("/" repeated, 593px), 0.43 for the reasons (#1235 round 3's 18,060 repeated-glyph
 * lines); and 0.023 at its tightest,
 * that 1,741px line, where CI pins it (a margin of 0.45, flat to 580px or growing from 576 reads it short). A flat half
 * unit read a 12px line short past about 1,000px and a 10.67px one past 800 (#1235's final reviews); measured on the
 * width alone, without the size, the repeated narrow glyphs read 10 lines short (its round-2 review). At 1/16 the
 * adversary's review of #1235 read labels with marks and delta lines 1/64px short (`fixtures/lineFitShortLines.ts`).
 */
export const FIT_NOISE_UNITS = 1 / 2;
/** The 12px-equivalent line width (px) the noise margin is flat to (`FIT_NOISE_UNITS`). */
export const FIT_NOISE_FLAT_PX = 512;
/** Past `FIT_NOISE_FLAT_PX`, the 12px-equivalent line width (px) that adds a unit to the noise margin. */
export const FIT_NOISE_PX_PER_UNIT = 1856;
/** The size the margin's widths are measured at. */
const FIT_NOISE_SIZE_PX = 12;
/** The noise margin, in units, of a line whose exact sum is `exactPx`, set at `fontPx` (`FIT_NOISE_UNITS`). */
export const fitMarginUnits = (exactPx: number, fontPx: number): number => FIT_NOISE_UNITS
  + Math.max(0, exactPx * (FIT_NOISE_SIZE_PX / fontPx) ** 2 - FIT_NOISE_FLAT_PX) / FIT_NOISE_PX_PER_UNIT;

/**
 * Chromium's own float noise on ONE run's width (a min-content or max-content width a column is sized by), in units:
 * within 0.024 of a unit either way on the 630-case grid and 600 random strings (`packLineFit.test.ts`); a sixteenth.
 * The bounds `CHROMIUM_LEAST` and `CHROMIUM_MOST` take a column at count it.
 */
export const RUN_NOISE_UNITS = 1 / 16;

/**
 * The width a line takes as Chromium's line breaker counts it: `exactPx`, the exact advance sum of the line (its words,
 * a soft hyphen's hyphen, a 9pt label's mark: `packLineWrap.linesForText`), set at `fontPx`, plus the noise margin for
 * its width and size (`fitMarginUnits`), floored to the 1/64px unit ONCE for the whole line.
 */
export const fitUnitsPx = (exactPx: number, fontPx: number): number => Math.floor(exactPx * UNIT + fitMarginUnits(exactPx, fontPx)) / UNIT;
