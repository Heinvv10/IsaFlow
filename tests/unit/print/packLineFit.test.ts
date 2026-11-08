/**
 * WHETHER A LINE HOLDS ONE MORE PIECE IS DECIDED AS CHROMIUM'S LINE BREAKER DECIDES IT: every box on the line summed
 * exactly and floored to the 1/64px unit once, with `FIT_NOISE_UNITS` for Chromium's own float noise
 * (`packGlyphRuler.fitUnitsPx`), never at the never-short width a column is sized by.
 *
 * For each case, the narrowest width (to the unit) at which Chromium keeps the line on one line is searched for, and
 * held to the model's (`support/lineFitHarness.ts`): never narrower (a line the model fits, Chromium fits), and over by
 * at most one unit, on at most the measured share plus stated headroom: the 630-case grid, 600 random strings of the
 * glyphs all three faces set, KPI labels with their marks and delta lines with their cues, every line the adversary's
 * review of #1235 found short at a 1/16-unit margin, 1,500 random lines of 2 to 23 words and 40 to 80 characters
 * (runs at the pack's sizes and weights with and without a mark, labels with marks, delta lines, reasons), every
 * column heading line with each mark it can carry, texts that end at a soft hyphen, marked labels at every ending (and
 * their line counts from min-content up), and 21,331 lines of 100 to 1,800px, random and of one glyph repeated (the
 * noise margin grows with the line and its glyphs: `packGlyphRuler.fitMarginUnits`). `packRealLines.test.ts` walks the
 * pack's own wording.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { textExactPx, type FigureWeight } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { labelMarkExactPx, type KpiTile } from '@/modules/accounting/services/packs/pages/packFigureFit';
import { kpiTileLines } from '@/modules/accounting/services/packs/pages/packKpiLayout';
import { PackRefusal } from '@/modules/accounting/services/packs/packRefusal';
import { markedPieces, pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { linesForText } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { labelLineCount } from '@/modules/accounting/services/packs/pages/packTableLayout';
import { PACK_TABLE_COLUMN_LABEL } from '@/modules/accounting/services/packs/pages/packTableModel';
import { launchPrintChromium } from './printChromium';
import { deltaCase, fillCase, headingCase, hold, holdLines, labelCase, reasonCase, runCase, type Case } from './support/lineFitHarness';
import { ADVERSARY_SHORT_LINES } from './fixtures/lineFitShortLines';
import { longLines, repeatedGlyphLines } from './fixtures/lineFitLongLines';
import { mulberry32 } from './support/mulberry32';

let browser: Browser;
beforeAll(async () => { browser = await launchPrintChromium(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const WEIGHTS: FigureWeight[] = [400, 500, 600];
const FILES = ['IBMPlexSans-Regular.woff2', 'IBMPlexSans-Medium.woff2', 'IBMPlexSans-SemiBold.woff2'];
const sets = FILES.map((f) => new Set(fontkit.create(readFileSync(path.join(process.cwd(), 'public/fonts', f))).characterSet));
const GLYPHS = [...sets[0]!].filter((c) => sets.every((s) => s.has(c)) && c > 0x20 && c !== 0xad && !/[\p{M}\p{C}\p{Z}]/u.test(String.fromCodePoint(c))).sort((a, b) => a - b);


/**
 * How many over by a unit each set may have. Measured: grid 353 of 630, random 308 of 600, labels 107 of 128, deltas 24
 * of 48, the adversary's lines 0 of 57 and mixed 718 of 1,500 (0 and 683 at a flat half-unit margin), headings 124 of 289,
 * soft hyphens 153 of 228, marks after a trailing space 165 of 242, marks at each ending 377 of 496, long lines 7,257
 * of 17,996, one glyph repeated 1,181 of 3,335 (the noise margin, `packGlyphRuler.fitMarginUnits`, takes a unit wherever
 * an exact sum's fraction of a unit is past one less the margin; a heading's mark box and a soft hyphen's hyphen are
 * rounded up on their own). The caps are those and about 5% of headroom (3 lines on the adversary's 57; 2 of
 * a set of 48). The random sets are drawn by `support/mulberry32.ts` (600 and 1,500 distinct lines; the LCG they were drawn
 * by overflowed and repeated: the mixed set was 627 distinct).
 */
const OVER = { grid: 370, random: 325, labels: 115, deltas: 26, adversary: 3, mixed: 760, headings: 131, softHyphen: 161, spacedMark: 174, markEnds: 395, long: 7620, repeated: 1240 } as const;

it('the 630-case grid: never narrower than Chromium', async () => {
  const texts = ['(133 500 000)', '9 000 000', 'Telecommunications', 'AVATAR WAVE', 'Revenue', '45.0%', 'To', 'xy', 'Operating expenses', 'W', 'nnnnnnnnnnnnnnnnnnnn', 'R&D', 'Ff', 'office', 'VAT'];
  const sizes = [6, 7, 9, 10, 10.5757, 11, 12, 13.3333, 14.6667, 16, 17, 20.5, 29.3333, 40];
  const cases = texts.flatMap((t) => sizes.flatMap((px) => WEIGHTS.map((w) => runCase(`a ${t}`, px, w))));
  expect(cases).toHaveLength(630);
  report('grid', await hold(browser, cases, OVER.grid), cases.length);
}, 300_000);

it('600 random strings of the glyphs every face sets: never narrower than Chromium', async () => {
  const random = mulberry32(11);
  const next = (): number => random.next().value as number;
  const sizes = [6, 8, 9.3333, 10, 10.5757, 12, 13.3333, 14.6667, 16, 22, 29.3333];
  const cases: Case[] = [];
  for (let i = 0; i < 600; i += 1) {
    let t = '';
    const n = 1 + Math.floor(next() * 14);
    for (let j = 0; j < n; j += 1) t += String.fromCodePoint(GLYPHS[Math.floor(next() * GLYPHS.length)]!);
    cases.push(runCase(`a ${t}`, sizes[i % sizes.length]!, WEIGHTS[i % 3]!));
  }
  // Every line its own (a generator that repeats would hold fewer lines than it says).
  expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  report('random', await hold(browser, cases, OVER.random), cases.length);
}, 300_000);

const LABELS = ['Gross margin', 'Revenue growth', 'Net profit', 'Operating expenses', 'Debt to equity', 'Current ratio', 'Cash conversion', 'Debtor days',
  'Creditor days', 'EBITDA margin', 'Net debt to EBITDA', 'Quick ratio', 'Return on equity', 'Interest cover', 'Gross profit', 'Opex ratio'];

it('a KPI label with its footnote mark, and a delta line with its cue: never narrower than Chromium', async () => {
  const labels = LABELS.flatMap((label) => [1, 2, 3, 7, 9, 10, 12, 22].map((n) => labelCase(label, n)));
  report('labels', await hold(browser, labels, OVER.labels), labels.length);
  const deltas = ['\u2191', '\u2193', '\u2192'].flatMap((arrow) => ['up 12.0%', 'down 3.4%', 'flat on 0.0%', 'up 1 234.5pp'].flatMap((v) =>
    ['prior period', 'budget', 'prior year', 'same month last year'].map((basis) => deltaCase(`${v} ${basis}`, arrow))));
  report('deltas', await hold(browser, deltas, OVER.deltas), deltas.length);
}, 300_000);

it('every line the adversary found short at a 1/16-unit margin: never narrower than Chromium now', async () => {
  const cases = ADVERSARY_SHORT_LINES.map((l) => {
    if (l.kind === 'plain') return runCase(`a ${l.text}`, l.px, l.weight);
    if (l.kind === 'mark') return labelCase(`a ${l.text}`, l.mark);
    if (l.kind === 'delta') return deltaCase(l.text, l.arrow);
    return reasonCase(`a ${l.text}`);
  });
  expect(cases.length).toBeGreaterThan(50);
  report('adversary', await hold(browser, cases, OVER.adversary), cases.length);
}, 300_000);

const WORDS = ('the of and to in revenue profit margin AVATAR WAVE Ty To Yo LTA office ffi fluffy Telecommunications 1 234 567 (13 350 000) '
  + '45.0% R&D VAT W nnnn iiii llll mmm Ωμέγα Выручка Ærø prior period budget same month last year not meaningful because comparative base '
  + 'negative Depreciation amortisation Inventories receivables Proceeds disposal property plant equipment intangibles').split(' ');

it('1,500 random lines, multi-box and long (2 to 23 words, 40 to 80 characters among them): never narrower than Chromium', async () => {
  const random = mulberry32(29);
  const next = (): number => random.next().value as number;
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(next() * a.length)]!;
  const cases: Case[] = [];
  for (let i = 0; i < 1500; i += 1) {
    const long = i % 3 === 0;
    const words: string[] = [];
    const target = 40 + Math.floor(next() * 41);
    const count = 2 + Math.floor(next() * 22);
    while (long ? words.join(' ').length < target : words.length < count) {
      words.push(next() < 0.25 ? Array.from({ length: 1 + Math.floor(next() * 8) }, () => String.fromCodePoint(pick(GLYPHS))).join('') : pick(WORDS));
    }
    const text = words.join(' ');
    const kind = i % 5;
    // The pack's wrapped text: 9pt labels and deltas (12px), 11pt reasons (14.667px), table labels at their weights.
    if (kind === 0) cases.push(runCase(text, 12, pick(WEIGHTS), next() < 0.5 ? 1 + Math.floor(next() * 30) : null));
    else if (kind === 1) cases.push(labelCase(text, 1 + Math.floor(next() * 30)));
    else if (kind === 2) cases.push(deltaCase(text, pick(['\u2191', '\u2193', '\u2192'])));
    else if (kind === 3) cases.push(reasonCase(text));
    else cases.push(runCase(text, pick([10.6667, 12, 14.6667]), pick(WEIGHTS)));
  }
  // Every line its own (a generator that repeats would hold fewer lines than it says).
  expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  report('mixed', await hold(browser, cases, OVER.mixed), cases.length);
}, 900_000);

it('every column heading line (each run of two words or more) with each mark 1 to 40 it can carry: never narrower than Chromium', async () => {
  const cases: Case[] = [];
  for (const label of new Set(Object.values(PACK_TABLE_COLUMN_LABEL))) {
    const words = label.split(' ');
    for (let a = 0; a < words.length; a += 1) {
      for (let b = a + 2; b <= words.length; b += 1) {
        const line = words.slice(a, b).join(' ');
        for (const mark of b === words.length ? [null, ...Array.from({ length: 40 }, (unused, n) => n + 1)] : [null]) cases.push(headingCase(line, mark));
      }
    }
  }
  expect(cases.length).toBeGreaterThan(250);
  report('headings', await hold(browser, cases, OVER.headings), cases.length);
}, 300_000);

/** A KPI tile of `label` and its mark, nothing else. */
const tile = (label: string, mark: number | null): KpiTile => ({ label, trendFootnote: mark, figure: { value: 1 }, delta: null, sparklineSvg: null }) as unknown as KpiTile;
const sup = (mark: number | null): string => (mark === null ? '' : `<sup class="pack-footnote-marker">${mark}</sup>`);

/**
 * Each text as a KPI label and a table row label at each weight, bare and with marks 3 and 12, by the production fills.
 * A KPI label holding a tab or a line feed is refused (`packKpiLayout.inPackFaces`), so it is a table label only. A
 * label and mark of one piece never wrap, so they decide nothing and are left out.
 */
function markedFills(texts: readonly string[], marks: ReadonlyArray<number | null> = [null, 3, 12]): Case[] {
  return texts.flatMap((text) => marks.filter((mark) => markedPieces(text, mark !== null).length > 1).flatMap((mark) => [
    ...(/[\t\n\r]/.test(text) ? [] : [fillCase(`kpi label ${JSON.stringify(text)}^${mark}`, `<span class="pack-kpi-label">${text}${sup(mark)}</span>`, (px) => kpiTileLines(tile(text, mark), px).label)]),
    ...WEIGHTS.map((w) => fillCase(`table label ${w} ${JSON.stringify(text)}^${mark}`, `<span style="font-size:12px;font-weight:${w};white-space:normal">${text}${sup(mark)}</span>`,
      (px) => labelLineCount(text, mark, w, px, 0))),
  ]));
}

it('a label that ends at a space (a tab, a line feed, a run of them) before its mark: the mark is a word of its own, never narrower than Chromium', async () => {
  const texts = [...LABELS.map((l) => `${l} `), 'Gross margin\u00AD ', 'Net profit\t', 'Debtor days\n', 'Revenue growth   ', 'Interest\u00A0cover '];
  const cases = markedFills(texts);
  expect(() => kpiTileLines(tile('Net profit\t', 3), 100)).toThrow(PackRefusal);
  report('spacedMark', await hold(browser, cases, OVER.spacedMark), cases.length);
  lineReport('spacedMark', await holdLines(browser, cases));
}, 300_000);

it('a text that ends at a soft hyphen keeps the hyphen\'s room on its last line (KPI labels, table labels at each weight): never narrower than Chromium', async () => {
  const texts = [...LABELS.map((l) => `${l}\u00AD`), 'Operating ex\u00ADpenses\u00AD', 'Return on equity\u00AD\u00AD', 'Gross margin\u00AD '];
  const cases = markedFills(texts);
  report('softHyphen', await hold(browser, cases, OVER.softHyphen), cases.length);
  lineReport('softHyphen', await holdLines(browser, cases));
  // A soft hyphen alone after a space: Chromium keeps the hyphen's room after the words and hangs the space; the model
  // counts the space too, so it is over by the space (never short: unfixed, the model fitted it 5px short).
  const lone = WEIGHTS.map((w) => fillCase(`table label ${w} "Net profit \u00AD"`, `<span style="font-size:12px;font-weight:${w};white-space:normal">Net profit \u00AD</span>`,
    (px) => linesForText(pieces('Net profit \u00AD'), { exactPx: (t, hyphen) => textExactPx(t, 12, w, hyphen), fontPx: 12 }, 0, px, 0)));
  await hold(browser, lone, lone.length, 64 * 3);
}, 300_000);

it('18,000 random lines of 100 to 1,800px at the pack\'s sizes (12px at each weight, 10.67px, 11pt reasons): never narrower than Chromium, the margin growing with the line', async () => {
  const cases = longLines();
  expect(cases.length).toBeGreaterThan(17_000);
  // Past about 1,400px the margin itself passes a unit, so a line can be two units over.
  report('long', await hold(browser, cases, OVER.long, 2), cases.length);
}, 900_000);

// One glyph repeated is where Chromium's noise runs furthest for a line's width ("fff..." at 10.67px/500 is 1.39 units
// past its exact sum at 1,741px), so these hold the margin's growth. Over is not bounded here: Chromium sets a run of
// slashes at 10.67px/500 up to 5 units NARROWER than its exact sum (the model is over, the safe way).
it('3,335 lines of one glyph repeated, 150 to 1,800px at the pack\'s sizes: never narrower than Chromium', async () => {
  const cases = repeatedGlyphLines();
  expect(cases).toHaveLength(3335);
  report('repeated', await hold(browser, cases, OVER.repeated, 64), cases.length);
}, 900_000);

// Chromium reads across the <sup>: it breaks before a mark wherever it would break before a digit. Each ending held: the
// ones that break (a soft hyphen, a hyphen, the dashes, a zero-width space, break-after spaces, an ellipsis, a question
// mark, U+2010 and U+2012) and ones that hold (a slash, a closing bracket, stops, a percent sign, a no-break space or hyphen).
it('a marked label at each ending: the one-line width never narrower than Chromium, and never a line fewer at any width from its min-content up (the mark on a line of its own counted)', async () => {
  const ends = ['\u00AD', '-', '\u2013', '\u2014', '\u200B', '\u2009', '\u2002', '\u2026', '?', '\u2010', '\u2012', '/', ')', '.', ',', '%', '\u00A0', '\u2011', '\u00AD\u00AD'];
  const texts = ['Gross margin', 'Telecommunications', 'Intercompany', `ab ${'n'.repeat(30)}`].flatMap((base) => ends.map((end) => `${base}${end}`));
  const cases = markedFills(texts, [1, 12]);
  expect(cases.length).toBeGreaterThan(450);
  report('markEnds', await hold(browser, cases, OVER.markEnds), cases.length);
  lineReport('markEnds', await holdLines(browser, cases));
}, 600_000);

/** How many (case, width) pairs the model sets a line more than Chromium at, printed (never fewer is what is held). */
function lineReport(set: string, more: number): void {
  process.stdout.write(`LINEFIT ${set} lines: ${more} widths a line over\n`);
}

/** The over count each set measured, printed so a cap can be set from it. */
function report(set: keyof typeof OVER, over: number, of: number): void {
  process.stdout.write(`LINEFIT ${set}: ${over} of ${of} over by a unit (cap ${OVER[set]})\n`);
}
