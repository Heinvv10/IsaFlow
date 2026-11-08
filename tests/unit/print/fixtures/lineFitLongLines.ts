/**
 * LINES OF 100 TO 1,800px AT THE PACK'S SIZES, for holding the line fit's noise margin where it grows
 * (`packGlyphRuler.fitMarginUnits`): 18,000 lines, six streams of 3,000 (seeds 1 to 6), each line random pack words and
 * runs of the glyphs all three faces set until its exact sum passes a random target of 100 to 1,700px; half at 12px
 * (a weight each), a quarter at 10.67px (a heading's size), a quarter 11pt reasons. Seeded, so the set is the one the
 * margin was measured on; a line of one piece (it never wraps) is left out (`support/mulberry32.ts`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as fontkit from 'fontkit';
import { textExactPx, type FigureWeight } from '@/modules/accounting/services/packs/pages/packFigureWidth';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { reasonExactPx } from '@/modules/accounting/services/packs/pages/packReasonWidth';
import { reasonCase, runCase, type Case } from '../support/lineFitHarness';
import { mulberry32 } from '../support/mulberry32';

const FILES = ['IBMPlexSans-Regular.woff2', 'IBMPlexSans-Medium.woff2', 'IBMPlexSans-SemiBold.woff2'];

const WORDS = ('the of and to in revenue profit margin AVATAR WAVE Ty To Yo LTA office ffi fluffy Telecommunications 1 234 567 (13 350 000) '
  + '45.0% R&D VAT W nnnn iiii llll mmm Ωμέγα Выручка Ærø prior period budget same month last year not meaningful because comparative base '
  + 'negative Depreciation amortisation Inventories receivables Proceeds disposal property plant equipment intangibles').split(' ');

export function longLines(): Case[] {
  const sets = FILES.map((f) => new Set(fontkit.create(readFileSync(path.join(process.cwd(), 'public/fonts', f))).characterSet));
  const glyphs = [...sets[0]!].filter((c) => sets.every((s) => s.has(c)) && c > 0x20 && c !== 0xad && !/[\p{M}\p{C}\p{Z}]/u.test(String.fromCodePoint(c))).sort((a, b) => a - b);
  const cases: Case[] = [];
  for (let seed = 1; seed <= 6; seed += 1) {
    const random = mulberry32(seed);
    const next = (): number => random.next().value as number;
    const pick = <T,>(a: readonly T[]): T => a[Math.floor(next() * a.length)]!;
    for (let i = 0; i < 3000; i += 1) {
      const targetPx = 100 + next() * 1600;
      const kind = pick(['run12', 'run12', 'reason', 'run10'] as const);
      const px = kind === 'run10' ? 10.6667 : 12;
      const weight = pick<FigureWeight>([400, 500, 600]);
      const exact = (t: string): number => (kind === 'reason' ? reasonExactPx(t) : textExactPx(t, px, weight));
      const words: string[] = [];
      while (exact(words.join(' ')) < targetPx) {
        words.push(next() < 0.2 ? Array.from({ length: 1 + Math.floor(next() * 8) }, () => String.fromCodePoint(pick(glyphs))).join('') : pick(WORDS));
      }
      const text = words.join(' ');
      // A line of one piece never wraps, so it decides nothing (a long word past a short target).
      if (pieces(text).length < 2) continue;
      cases.push(kind === 'reason' ? reasonCase(text) : runCase(text, px, weight));
    }
  }
  return cases;
}
