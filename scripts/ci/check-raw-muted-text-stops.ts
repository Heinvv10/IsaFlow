/**
 * check-raw-muted-text-stops - raw `text-gray/slate-400/500` stops may only fall in number.
 *
 * scripts/ci/raw-muted-text-stops.baseline.json maps file -> count of bare tokens (see
 * rawMutedTextRule.ts). Fails when a file gains one (use text-ink-muted / text-ink-faint, or pair
 * the stop with a dark: variant), and when a file's count falls without the baseline following.
 *
 * Run:   bun scripts/ci/check-raw-muted-text-stops.ts
 * Lower: bun scripts/ci/check-raw-muted-text-stops.ts --write   (only ever lowers or drops entries)
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { countRawMutedTextStops, judge, type Baseline } from './rawMutedTextRule';

const BASELINE_FILE = path.join(__dirname, 'raw-muted-text-stops.baseline.json');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

function currentCounts(): Baseline {
  const counts: Baseline = {};
  for (const root of ['src', 'pages']) {
    for (const file of walk(root)) {
      const n = countRawMutedTextStops(readFileSync(file, 'utf8'));
      if (n > 0) counts[file.split(path.sep).join('/')] = n;
    }
  }
  return counts;
}

function main(): number {
  const write = process.argv.includes('--write');
  const counts = currentCounts();
  if (!existsSync(BASELINE_FILE)) {
    if (!write) {
      console.error('[raw-muted-text-stops] baseline is missing; create it with --write');
      return 1;
    }
    writeFileSync(BASELINE_FILE, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`[raw-muted-text-stops] wrote ${Object.keys(counts).length} entries`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline;
  const { grew, shrank } = judge(counts, baseline);
  if (write) {
    const lowered: Baseline = {};
    for (const [f, allowed] of Object.entries(baseline)) {
      const now = Math.min(counts[f] ?? 0, allowed);
      if (now > 0) lowered[f] = now;
    }
    writeFileSync(BASELINE_FILE, `${JSON.stringify(lowered, null, 2)}\n`);
    console.log(`[raw-muted-text-stops] lowered ${shrank.length} entries`);
    return grew.length > 0 ? 1 : 0;
  }
  for (const g of grew) {
    console.error(`[raw-muted-text-stops] NEW: ${g}. Use text-ink-muted / text-ink-faint, or write the dark twin (dark:text-slate-400); do not raise the baseline.`);
  }
  for (const s of shrank) {
    console.error(`[raw-muted-text-stops] LOWER THE BASELINE: ${s} (bun scripts/ci/check-raw-muted-text-stops.ts --write).`);
  }
  if (grew.length + shrank.length > 0) return 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`[raw-muted-text-stops] ok: ${total} raw stops in ${Object.keys(counts).length} files, none new`);
  return 0;
}

process.exit(main());
