/**
 * THE PAIR TABLE'S GENERATOR, WITHOUT CHROMIUM (the scan itself takes hours in production's image, by hand):
 *  - a synthetic scan (classes, two tables and flips at random, the first and last 4-gram among the flips) written by
 *    `pairDataSource` and read back by production's reader (`packBreakPairsReader.pairTableReader`): every 4-gram as
 *    the scan said, and every code point in its class;
 *  - `scanPairs` refuses to write a table from classes that have not settled;
 *  - the committed data file stays within the 300-line cap, and covers exactly the domain `PAIR_DOMAIN` computes today
 *    (a Node or ICU change that moves a code point in or out goes red here, not in production).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAIR_CLASS_RANGES } from '@/modules/accounting/services/packs/pages/packBreakPairsData';
import { pairTableReader, type PairTableData } from '@/modules/accounting/services/packs/pages/packBreakPairsReader';
import { mulberry32 } from '../print/support/mulberry32';
import { scanPairs, type PairJob, type PairScan } from './breakPairsScan';
import { PAIR_DOMAIN } from './breakPairsDomain';
import { pairDataSource } from './breakPairsTable';

const SPECIALS = 5;

/** A scan of `k` classes over `codes` code points, its tables and flips drawn from `seed`. */
function syntheticScan(k: number, codes: number, seed: number): PairScan {
  const random = mulberry32(seed);
  const next = (): number => random.next().value as number;
  const nl = SPECIALS + k;
  // Structured as Chromium's are (a few kinds of class and context), so the fold fits its bytes; the flips at random.
  const kindOf = Array.from({ length: Math.max(k, nl) }, () => Math.floor(next() * 4));
  const bitsOf = (count: number, at: (i: number) => number): string => {
    let out = '';
    for (let i = 0; i < count; i += 4) out += [0, 1, 2, 3].reduce((acc, j) => acc * 2 + (i + j < count ? at(i + j) : 0), 0).toString(16);
    return out;
  };
  const k2 = k * k;
  const left = bitsOf(nl * k2, (i) => ((kindOf[Math.floor(i / k2)]! + kindOf[Math.floor((i % k2) / k)]! * 2 + kindOf[i % k]!) % 3 === 0 ? 1 : 0));
  const right = bitsOf(k2 * nl, (i) => ((kindOf[Math.floor(i / nl / k)]! + kindOf[Math.floor(i / nl) % k]! + kindOf[i % nl]! * 3) % 2 === 0 ? 1 : 0));
  const quads = nl * k * k * nl;
  const flips = new Set<number>([0, quads - 1]);
  while (flips.size < 60) flips.add(Math.floor(next() * quads));
  const classOf = new Map<number, number>();
  for (let c = 0; c < codes; c += 1) classOf.set(0x21 + c * 3, c < k ? c : Math.floor(next() * k));
  return { classOf, classes: k, lefts: nl, rights: nl, left, right, flips: [...flips].sort((a, b) => a - b), quads };
}

/** What the scan says of the 4-gram `(l, a, b, r)`: both tables, but for a flip. */
function scanSays(scan: PairScan, flips: ReadonlySet<number>, l: number, a: number, b: number, r: number): boolean {
  const k2 = scan.classes * scan.classes;
  const bit = (h: string, i: number): number => (parseInt(h[i >> 2]!, 16) >> (3 - (i & 3))) & 1;
  const pair = a * scan.classes + b;
  const said = bit(scan.left, l * k2 + pair) === 1 && bit(scan.right, pair * scan.rights + r) === 1;
  return flips.has((l * k2 + pair) * scan.rights + r) ? !said : said;
}

/** The data file's source read back: its numbers, groups, strings and class runs. */
function readSource(source: string): { data: PairTableData; ranges: Array<[number, number, number]> } {
  const num = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+);`).exec(source)![1]);
  const text = (name: string): string => [...new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\]\\.join`).exec(source)![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
  const list = (name: string): number[] => new RegExp(`export const ${name}: readonly number\\[\\] = \\[([\\s\\S]*?)\\];`).exec(source)![1]!.match(/\d+/g)!.map(Number);
  const ranges = [...source.matchAll(/\[0x([0-9a-f]+), 0x([0-9a-f]+), (\d+)\]/g)].map((m): [number, number, number] => [parseInt(m[1]!, 16), parseInt(m[2]!, 16), Number(m[3])]);
  return {
    data: {
      classes: num('PAIR_CLASSES'), lefts: num('PAIR_LEFTS'), rights: num('PAIR_RIGHTS'), groupsBefore: num('PAIR_GROUPS_BEFORE'), groupsAfter: num('PAIR_GROUPS_AFTER'),
      beforeGroup: list('PAIR_BEFORE_GROUP'), afterGroup: list('PAIR_AFTER_GROUP'), kinds: text('PAIR_KINDS'), kindRows: text('PAIR_KIND_ROWS'), rows: text('PAIR_ROWS'),
    },
    ranges,
  };
}

describe('the pair table\'s generator', () => {
  it.each([[10, 40, 1], [23, 90, 2], [31, 200, 3]])('%i classes, %i code points: written and read back, every 4-gram is the scan\'s', (k, codes, seed) => {
    const scan = syntheticScan(k, codes, seed);
    const { data, ranges } = readSource(pairDataSource(scan));
    const read = pairTableReader(data, SPECIALS);
    const flips = new Set(scan.flips);
    let wrong = 0;
    for (let l = 0; l < scan.lefts; l += 1) for (let a = 0; a < k; a += 1) for (let b = 0; b < k; b += 1) for (let r = 0; r < scan.rights; r += 1) {
      if (read(l, a, b, r) !== scanSays(scan, flips, l, a, b, r)) wrong += 1;
    }
    expect(wrong, `of ${scan.quads} 4-grams`).toBe(0);
    const classOf = new Map<number, number>();
    for (const [from, to, cls] of ranges) for (let c = from; c <= to; c += 1) classOf.set(c, cls);
    expect(classOf).toEqual(scan.classOf);
  });

  it('a scan whose classes never settle is refused, not written', async () => {
    let round = 0;
    const run = async (job: PairJob): Promise<string[]> => {
      if (job.kind === 'tables') {
        round += 1;
        const k = job.reps.length;
        return [`L|${'0'.repeat(Math.ceil((job.lefts.length * k * k) / 4))}`, `R|${'0'.repeat(Math.ceil((k * k * job.rights.length) / 4))}`, 'E|tables'];
      }
      if (job.kind === 'sig') return [...job.domain.map((cp) => `S|${cp.toString(16)}|${cp < 0x22 + round ? 'a' : 'b'}`), 'E|sig'];
      return ['E|quads'];
    };
    await expect(scanPairs(run, [0x21, 0x22, 0x23, 0x24, 0x25, 0x26], [0x21], () => undefined, 300, 3)).rejects.toThrow(/did not settle in 3 rounds/);
  });

  it('the committed data file is within the 300-line cap', () => {
    const lines = readFileSync(path.resolve(__dirname, '../../../src/modules/accounting/services/packs/pages/packBreakPairsData.ts'), 'utf8').split('\n').length;
    expect(lines).toBeLessThanOrEqual(300);
  });

  it('the committed table covers exactly the domain PAIR_DOMAIN computes on this Node (its ICU decides the categories)', () => {
    const table = new Set<number>();
    for (const [from, to] of PAIR_CLASS_RANGES) for (let c = from; c <= to; c += 1) table.add(c);
    const domain = new Set(PAIR_DOMAIN());
    const missing = [...domain].filter((c) => !table.has(c)).map((c) => `U+${c.toString(16)}`);
    const extra = [...table].filter((c) => !domain.has(c)).map((c) => `U+${c.toString(16)}`);
    expect({ missing: missing.slice(0, 20), extra: extra.slice(0, 20) }).toEqual({ missing: [], extra: [] });
  });
});
