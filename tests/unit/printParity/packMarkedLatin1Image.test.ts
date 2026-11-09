/**
 * A LATIN-1 PAIR WITH A MARK, AS PRODUCTION'S CHROMIUM BREAKS IT (`packMarkedLatin1.ts`), in a throwaway container of
 * production's Gotenberg image:
 *  - every pair of the Latin-1 characters the pair table covers, the first with U+0301, a letter, a digit or nothing
 *    before and a letter or a digit after; a hyphen with a mark after one of each pair class; an unmarked hyphen after
 *    every marked Latin-1 character; and the marked census (`print/fixtures/everyBreakCensus.markedCensus`): the model
 *    breaks exactly where production breaks, in both directions;
 *  - with REGENERATE_MARKED=1, `packMarkedLatin1Data.ts` is probed afresh and written.
 * Velo only; re-run it whenever the gotenberg image changes.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAIR_CLASS_RANGES } from '@/modules/accounting/services/packs/pages/packBreakPairsData';
import { printedText } from '@/modules/accounting/services/packs/pages/packPrintedText';
import { startGotenberg, type Gotenberg } from './gotenbergParity';
import { breaksInImage } from './inImage';
import { markedLatin1Source } from './lineBreakClasses';
import { paritySkip } from './paritySkip';
import { BREAKS_OF, DOMAIN } from '../print/fixtures/breakPairsCensus';
import { allDifferences, markedCensus } from '../print/fixtures/everyBreakCensus';

const DATA = path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages/packMarkedLatin1Data.ts');
const unavailable = paritySkip();
let gotenberg: Gotenberg | undefined;
beforeAll(async () => { if (unavailable === null) gotenberg = await startGotenberg(); }, 180_000);
afterAll(() => { gotenberg?.stop(); });

const LATIN1 = DOMAIN.filter((c) => c.codePointAt(0)! < 0x100);
const MARK = '\u0301';
/** One character of each pair class: the contexts a marked hyphen is probed after. */
const CLASS_REPS = (): string[] => {
  const reps = new Map<number, number>();
  for (const [from, , cls] of PAIR_CLASS_RANGES) if (!reps.has(cls)) reps.set(cls, from);
  return [...new Set([...reps.values()].map((c) => String.fromCodePoint(c)))];
};

/** The probes, each [text, the offset of the break it reads]. */
function probes(): { pairs: Array<[string, number]>; opening: Array<[string, number]>; hyphenAfter: Array<[string, number]>; contexts: Array<[string, number]> } {
  const pairs = LATIN1.flatMap((x) => LATIN1.map((y): [string, number] => [`a${x}${MARK}${y}a`, 3]));
  const opening = LATIN1.flatMap((x) => LATIN1.map((y): [string, number] => [`${x}${MARK}${y}a`, 2]));
  const hyphenAfter = LATIN1.flatMap((c) => LATIN1.map((y): [string, number] => [`a${c}${MARK}-${y}a`, 4]));
  const contexts = CLASS_REPS().flatMap((c) => LATIN1.map((y): [string, number] => [`${c}-${MARK}${y}a`, c.length + 2]));
  return { pairs, opening, hyphenAfter, contexts };
}

describe.skipIf(unavailable !== null)(`marked Latin-1 pairs in production's image${unavailable === null ? '' : ` (SKIPPED: ${unavailable})`}`, () => {
  it('every marked Latin-1 pair in its contexts, and the marked census: the model breaks exactly where production does, both ways', async () => {
    const p = probes();
    const extra = ['1', ''].flatMap((l) => LATIN1.flatMap((x) => LATIN1.flatMap((y) => [`${l}${x}${MARK}${y}a`, `${l}${x}${MARK}${y}1`])));
    const texts = [...new Set([...[...p.pairs, ...p.opening, ...p.hyphenAfter, ...p.contexts].map(([t]) => t), ...extra, ...markedCensus().map(printedText)])];
    const wrong = allDifferences(texts, await breaksInImage(gotenberg!, BREAKS_OF, texts));
    expect(wrong.map((t) => JSON.stringify(t)).slice(0, 20), `${wrong.length} of ${texts.length} differ`).toEqual([]);
  }, 1_800_000);

  it.skipIf(process.env.REGENERATE_MARKED !== '1')('REGENERATE_MARKED=1: probes the marked pairs and writes packMarkedLatin1Data.ts', async () => {
    const p = probes();
    const read = async (list: Array<[string, number]>): Promise<boolean[]> => {
      const got = await breaksInImage(gotenberg!, BREAKS_OF, list.map(([t]) => t));
      return list.map(([, at], i) => {
        if (got[i]!.includes(-at)) throw new Error(`the break in ${JSON.stringify(list[i]![0])} cannot be read`);
        return got[i]!.includes(at);
      });
    };
    const [pairs, opening, hyphenAfter, contexts] = [await read(p.pairs), await read(p.opening), await read(p.hyphenAfter), await read(p.contexts)];
    // Each class's row for a marked hyphen after it: as after a letter (nothing to record), as opening a word, or never.
    const n = LATIN1.length;
    const hy = LATIN1.indexOf('-');
    const opensAfter: number[] = [];
    const holdsAfter: number[] = [];
    CLASS_REPS().forEach((c, k) => {
      const row = contexts.slice(k * n, (k + 1) * n);
      const same = (ref: boolean[]): boolean => row.every((b, y) => b === ref[hy * n + y]);
      if (same(pairs)) return;
      if (same(opening)) opensAfter.push(c.codePointAt(0)!);
      else if (row.every((b) => !b)) holdsAfter.push(c.codePointAt(0)!);
      else throw new Error(`a marked hyphen after ${JSON.stringify(c)} breaks as neither after a letter, opening a word nor never`);
    });
    writeFileSync(DATA, markedLatin1Source(LATIN1.map((c) => c.codePointAt(0)!), pairs, opening, hyphenAfter, opensAfter, holdsAfter));
  }, 1_800_000);
});
