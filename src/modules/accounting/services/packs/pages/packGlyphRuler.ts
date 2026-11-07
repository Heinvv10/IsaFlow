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

/** The script a run is shaped in; '' for the common and inherited characters, which join the run they stand in. */
function scriptOf(ch: string): string {
  if (/[\p{Script=Common}\p{Script=Inherited}]/u.test(ch)) return '';
  for (const script of ['Latin', 'Greek', 'Cyrillic']) if (new RegExp(`\\p{Script=${script}}`, 'u').test(ch)) return script;
  return 'Other';
}

/** `text` cut into the runs Chromium shapes apart: one script each, a common character joining the run it follows. */
export function scriptRuns(text: string): string[] {
  const runs: Array<{ script: string; text: string }> = [];
  for (const ch of text) {
    const script = scriptOf(ch);
    const last = runs[runs.length - 1];
    if (last !== undefined && (script === '' || last.script === '' || last.script === script)) {
      last.text += ch;
      if (last.script === '') last.script = script;
    } else runs.push({ script, text: ch });
  }
  return runs.map((r) => r.text);
}

/** Runs already shaped: their advance in font units, by weight and text (a pack shapes the same words many times). */
const SHAPED = new Map<string, number>();
const SHAPED_MAX = 50_000;

function unitsOf(f: Face, weight: FaceWeight, run: string): number {
  const key = `${weight}|${run}`;
  let units = SHAPED.get(key);
  if (units === undefined) {
    units = 0;
    for (const p of f.layout(run, FEATURES).positions) units += p.xAdvance;
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
 * soft hyphen in `text`, and Chromium sets a hyphen (U+2010, shaped on its own) after it.
 */
export function runPx(
  text: string, fontPx: number, weight: FaceWeight, fallbackPx: (cluster: string, sizePx: number) => number, letterSpacingPx = 0,
  hyphen = false,
): number {
  if (text === '' && !hyphen) return 0;
  const f = face(weight);
  const size = setSizePx(fontPx);
  let units = 0;
  let px = 0;
  let inside = '';
  const flush = (): void => {
    for (const run of scriptRuns(inside)) units += unitsOf(f, weight, run);
    inside = '';
  };
  // Chromium sets a soft hyphen and a zero-width space as nothing, and kerns across them; it sets a line or paragraph
  // separator as a space.
  for (const cluster of clustersOf(text.replace(/[\u00AD\u200B]/g, '').replace(/[\u2028\u2029]/g, ' '))) {
    px += letterSpacingPx;
    if (inFace(cluster)) inside += cluster;
    else { flush(); px += fallbackPx(cluster, size); }
  }
  flush();
  if (hyphen) units += unitsOf(f, weight, '\u2010');
  return Math.ceil((units * size / f.unitsPerEm + px) * UNIT - 1e-7) / UNIT + 1 / UNIT;
}
