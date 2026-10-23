/**
 * measure-suites — rewrites suite-seconds.json, the per-suite durations plan.ts
 * deals shards by, from the per-file lines of real gate logs:
 *   ✓ tests/integration/<file>.int.test.ts (N tests) 12345ms
 *
 * Run after a local gate run (CI_INTEGRATION=1 bun run ci, or
 * bash scripts/ci/integration/run.sh), which copies its shard logs to
 * .ci-integration-logs/; several runs' logs may be given and the median is kept:
 *   bun scripts/ci/integration/measure-suites.ts .ci-integration-logs/*.log [more logs...]
 *
 * Only suites at or above MIN_SECONDS are written; plan.ts weighs every other
 * suite at its fallback. A stale or missing entry costs wall time, never
 * correctness (the deal decides only which shard runs a suite).
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const MIN_SECONDS = 3;
const LINE = /^ *[✓❯×↓] (tests\/integration\/\S+\.int\.test\.ts) .*?(\d+)ms *$/;

/** Every `<file> <ms>` result line in a vitest log. */
export function parseSuiteTimes(log: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const line of log.split('\n')) {
    const m = LINE.exec(line);
    if (m) out.push([m[1]!, Number(m[2])]);
  }
  return out;
}

/** Median seconds per suite over every log, rounded up; only suites >= MIN_SECONDS, sorted by path. */
export function suiteSeconds(logs: string[]): Record<string, number> {
  const per = new Map<string, number[]>();
  for (const log of logs) {
    for (const [file, ms] of parseSuiteTimes(log)) per.set(file, [...(per.get(file) ?? []), ms]);
  }
  const out: Record<string, number> = {};
  for (const file of [...per.keys()].sort()) {
    const ms = per.get(file)!.sort((a, b) => a - b);
    const mid = ms.length >> 1;
    const median = ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2;
    const s = Math.ceil(median / 1000);
    if (s >= MIN_SECONDS) out[file] = s;
  }
  return out;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write('usage: bun scripts/ci/integration/measure-suites.ts <gate log>...\n');
    process.exit(2);
  }
  const table = suiteSeconds(files.map((f) => readFileSync(f, 'utf8')));
  if (Object.keys(table).length === 0) {
    process.stderr.write('no per-file result lines in those logs; nothing written\n');
    process.exit(1);
  }
  writeFileSync('scripts/ci/integration/suite-seconds.json', `${JSON.stringify(table, null, 2)}\n`);
  process.stdout.write(`suite-seconds.json: ${Object.keys(table).length} suites >= ${MIN_SECONDS}s\n`);
}
