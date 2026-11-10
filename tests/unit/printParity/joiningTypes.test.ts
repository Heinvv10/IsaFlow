/**
 * THE JOINING-LETTER TABLE (`print/fixtures/joiningLetterData.ts`, the joining sweep's letters): in order, apart, none the faces set, and the letters #1235's ninth
 * round found printed wider joined than alone among them; with JOINING_TYPE_TXT set to Unicode's
 * DerivedJoiningType.txt, written afresh.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOINING_FALLBACK } from '../print/fixtures/joiningLetterData';
import { joiningRuns, joiningSource, parseJoining, selfHosted } from './joiningTypes';

const ROOT = path.resolve(__dirname, '../../..');
const inTable = (cp: number): boolean => JOINING_FALLBACK.some(([from, to]) => cp >= from && cp <= to);

describe('the joining-letter table', () => {
  it('runs in order and apart, none of them a code point the faces set', () => {
    expect(JOINING_FALLBACK.length).toBeGreaterThan(40);
    JOINING_FALLBACK.forEach(([from, to], i) => {
      expect(from).toBeLessThanOrEqual(to);
      if (i > 0) expect(from).toBeGreaterThan(JOINING_FALLBACK[i - 1]![1] + 1);
      for (let c = from; c <= to; c += 1) expect(selfHosted(c), c.toString(16)).toBe(false);
    });
  });

  it('holds the round-9 letters and every joining script; not ZWJ, which the faces set, nor a mark', () => {
    for (const cp of [0x0728, 0x071d, 0x08a7, 0x185a, 0x189e, 0x1863, 0x1835, 0x1877, 0x1868, 0x06fc, 0x075d, 0x075e, 0x075f,
      0x0628, 0x0640, 0x07ca, 0x07fa, 0x1e900, 0xa840, 0x10ac0, 0x180a]) expect(inTable(cp), cp.toString(16)).toBe(true);
    for (const cp of [0x200d, 0x0041, 0x0301, 0x064e, 0x0730, 0x4e2d]) expect(inTable(cp), cp.toString(16)).toBe(false);
  });

  it.skipIf(process.env.JOINING_TYPE_TXT === undefined)('JOINING_TYPE_TXT: writes joiningLetterData.ts, and the committed table is what it writes', () => {
    const source = joiningSource(joiningRuns(parseJoining(readFileSync(process.env.JOINING_TYPE_TXT!, 'utf8'))));
    const file = path.join(ROOT, 'tests/unit/print/fixtures/joiningLetterData.ts');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, source);
    expect(before).toBe(source);
  });
});
