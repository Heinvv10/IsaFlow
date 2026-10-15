/**
 * vitest's per-file result lines, read one way for the whole integration gate:
 * shard.sh (exactly one per planned file), run.sh (the failing files) and the
 * skip report (scripts/ci/skippedIntegrationSuites.ts) all go through here.
 *
 *   ` ✓ tests/x.int.test.ts (12 tests | 1 failed | 3 skipped) 410ms`  (also ❯, ↓, ×)
 *
 * The form is vitest 4.1.2's default reporter's module line, as read in
 * node_modules/vitest/dist/chunks/index.0GYC6HAu.js (class DefaultReporter's
 * base: getModuleLog, getEntityPrefix, getDurationPrefix) and
 * utils.DK8FXp4T.js (formatProjectName, getStateSymbol). On a vitest upgrade,
 * re-read those: getModuleLog writes only the counts failed, skipped and todo,
 * and a line with any other count word is not read (it is then named as
 * unreadable, which fails loud). As the gate
 * runs it (NO_COLOR): `<mark>[ |<project>|][  TS ] <path> (<n> test[s][ | k
 * failed][ | k skipped][ | k todo])`, then ` <integer>ms` when it has a
 * duration, then ` <integer> MB heap used` with --logHeapUsage. Nothing else is
 * read: `1.50s` / `1m 2s` are the run summary's formatTime, `(slow)` is never
 * written, and `expected fail` is counted only in the summary. A coloured
 * project label (no NO_COLOR) is not read either. A line in any other form is
 * not a result: shard.sh then counts the file as missing, and the report and
 * the skip report name it (unreadable).
 *
 * Two hazards, both seen in real shard logs or by review:
 * - A suite's own output that ends without a newline runs into the reporter's
 *   line, and that output can carry a ✓ or × of its own
 *   (`[seed] ✓ migrated 3 rows↓ tests/a.int.test.ts (…)`). So the mark is not
 *   anchored to the line start, the path may not contain a mark, and the path is
 *   the one after the LAST mark.
 * - A stack trace or message can quote a result line. So the result must END
 *   the line: `(…)`, an optional duration, vitest's optional `N MB heap used`
 *   (--logHeapUsage), nothing else.
 *
 * Named limits: a line whose glued-in output itself ends with a whole quoted
 * result line is still read as one (the reporter never writes that); a line
 * holding two results reads only the last, so the first file has no result
 * line and its shard fails (closed).
 *
 * Pure except `unreadable`, which resolves paths (realpath); unit-tested in
 * tests/unit/ci/integrationResultLines.test.ts. The CLI is result-lines.ts.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface ResultLine {
  mark: string;
  file: string;
  total: number;
  /** `failed`, `skipped`, `todo`, … as vitest prints them after the total. */
  counts: Record<string, number>;
}

const RESULT = new RegExp('[✓❯↓×](?: \\|[^|\\n]*\\|)?(?:  TS )? ([^✓❯↓×\\s][^✓❯↓×]*?\\.test\\.ts) '
  + '\\((\\d+) tests?((?: \\| \\d+ (?:failed|skipped|todo))*)\\)(?: \\d+ms)?(?: \\d+ MB heap used)?\\s*$', 'u');
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function resultLine(raw: string): ResultLine | null {
  const m = RESULT.exec(raw.replace(ANSI, ''));
  if (!m) return null;
  const counts: Record<string, number> = {};
  for (const c of (m[3] ?? '').matchAll(/ \| (\d+) ([a-z]+)/g)) counts[c[2]!] = Number(c[1]);
  return { mark: m[0]!.charAt(0), file: m[1]!, total: Number(m[2]), counts };
}

export function resultLines(log: string): ResultLine[] {
  return log.split('\n').map(resultLine).filter((r): r is ResultLine => r !== null);
}

/** Every planned file without exactly one result line, with how many it has. */
export function wrongCounts(lines: ResultLine[], planned: string[]): { file: string; n: number }[] {
  const n = new Map<string, number>();
  for (const r of lines) n.set(r.file, (n.get(r.file) ?? 0) + 1);
  return planned.map((file) => ({ file, n: n.get(file) ?? 0 })).filter((c) => c.n !== 1);
}

/** A path with every symlink resolved, or as written when it cannot be (it does not exist). */
const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * The started files (absolute, as vitest records them; `root` is the repo) with no readable result line. Both sides
 * are compared as real paths: a cwd or a moduleId reached through a symlink still matches.
 */
export function unreadable(lines: ResultLine[], started: string[], root: string): string[] {
  const read = new Set(lines.map((r) => r.file));
  const top = `${real(root)}/`;
  const rel = started.filter((f) => f !== '').map((f) => {
    const p = isAbsolute(f) ? real(f) : f;
    return p.startsWith(top) ? p.slice(top.length) : p;
  });
  return [...new Set(rel)].filter((f) => !read.has(f));
}

/** The failing files (❯ or ×), one normalised line each, as the run's summary prints them. */
export function failingLines(lines: ResultLine[]): string[] {
  return lines.filter((r) => r.mark === '❯' || r.mark === '×').map((r) => {
    const extra = Object.entries(r.counts).map(([k, v]) => ` | ${v} ${k}`).join('');
    return ` ${r.mark} ${r.file} (${r.total} test${r.total === 1 ? '' : 's'}${extra})`;
  });
}
