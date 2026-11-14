/**
 * THE GATE'S PARTS TOGETHER RUN EVERY TEST FILE EXACTLY ONCE.
 *
 * ci.yml splits browser-tests (printShard.ts, a vitest sequencer) and the
 * integration suites (suiteRoute.ts sliceSuites, through plan.ts) over a matrix
 * of jobs. Each job computes its own share, so a deal that dropped or repeated
 * a file would pass every part while a file never ran.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FALLBACK_SECONDS, printShardFiles } from '../../../scripts/ci/printShard';
import { parsePart, sliceSuites } from '../../../scripts/ci/integration/suiteRoute';

const PRINT_SECONDS = JSON.parse(readFileSync('scripts/ci/print-seconds.json', 'utf8')) as Record<string, number>;
const SUITE_SECONDS = JSON.parse(readFileSync('scripts/ci/integration/suite-seconds.json', 'utf8')) as Record<string, number>;

/** The measured print files plus unmeasured ones, in an order that is not path order. */
const printFiles = [...Object.keys(PRINT_SECONDS), ...Array.from({ length: 35 }, (_, i) => `tests/unit/print/fast${i}.test.ts`)].reverse();
const weight = (f: string) => PRINT_SECONDS[f] ?? FALLBACK_SECONDS;

describe('printShardFiles', () => {
  it.each([1, 2, 3, 5, 7])('%i parts hold every file exactly once', (count) => {
    const parts = Array.from({ length: count }, (_, i) => printShardFiles(printFiles, i + 1, count, PRINT_SECONDS));
    expect(parts.flat().sort()).toEqual([...printFiles].sort());
  });

  it('gives the same deal whatever order vitest lists the files in', () => {
    expect(printShardFiles([...printFiles].sort(), 2, 5, PRINT_SECONDS)).toEqual(printShardFiles(printFiles, 2, 5, PRINT_SECONDS));
  });

  it('deals by seconds, not by count: no part runs more than the slowest file or an even share, plus one file', () => {
    const count = 5;
    const loads = Array.from({ length: count }, (_, i) =>
      printShardFiles(printFiles, i + 1, count, PRINT_SECONDS).reduce((sum, f) => sum + weight(f), 0));
    const total = printFiles.reduce((sum, f) => sum + weight(f), 0);
    const slowest = Math.max(...printFiles.map(weight));
    // LPT's bound: a part's load is at most max(slowest file, even share + the largest file it took last).
    for (const load of loads) expect(load).toBeLessThanOrEqual(Math.max(slowest, total / count + slowest));
    // The slowest file shares its part with nothing heavier than a fallback file.
    const heaviest = printFiles.find((f) => weight(f) === slowest);
    const withIt = loads.findIndex((_, i) => printShardFiles(printFiles, i + 1, count, PRINT_SECONDS).includes(heaviest ?? ''));
    expect(loads[withIt]).toBeLessThan(slowest + 10 * FALLBACK_SECONDS + 1);
  });
});

describe('sliceSuites', () => {
  const suites = [...Object.keys(SUITE_SECONDS), ...Array.from({ length: 400 }, (_, i) => `tests/integration/u${i}.int.test.ts`)]
    .map((file, i) => ({ file, db: i % 3 === 0 ? 'isaflow_test' : 'isaflow_schema_fixture' }));

  it.each([1, 2, 5, 8])('%i parts hold every suite exactly once, database kept', (parts) => {
    const all = Array.from({ length: parts }, (_, i) => sliceSuites(suites, i + 1, parts, SUITE_SECONDS, 1)).flat();
    expect(all.map((s) => `${s.db} ${s.file}`).sort()).toEqual(suites.map((s) => `${s.db} ${s.file}`).sort());
  });

  it('keeps the input order inside a part (the shard deal that follows is stable)', () => {
    const part = sliceSuites(suites, 3, 5, SUITE_SECONDS, 1);
    const at = part.map((s) => suites.indexOf(s));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('one part is every suite', () => {
    expect(sliceSuites(suites, 1, 1, SUITE_SECONDS, 1)).toEqual(suites);
  });
});

describe('parsePart', () => {
  it.each([['1/1', 1, 1], ['3/5', 3, 5], ['12/12', 12, 12]])('reads %s', (arg, part, parts) => {
    expect(parsePart(arg)).toEqual({ part, parts });
  });

  it.each(['0/3', '4/3', '1/0', '1', '1/3/5', 'a/3', ' 1/3', '1/3 ', '01/3', '-1/3', ''])('refuses %j', (arg) => {
    expect(parsePart(arg)).toBeNull();
  });
});
