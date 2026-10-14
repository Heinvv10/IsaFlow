/**
 * vitest's per-file result lines, read one way for the whole integration gate:
 * shard.sh (exactly one per planned file), run.sh (the failing files) and the
 * skip report (scripts/ci/skippedIntegrationSuites.ts) all go through here.
 *
 *   ` ✓ tests/x.int.test.ts (12 tests | 1 failed | 3 skipped) 410ms`  (also ❯, ↓, ×)
 *
 * Two hazards, both seen in real shard logs or by review:
 * - A suite's own output that ends without a newline runs into the reporter's
 *   line, and that output can carry a ✓ or × of its own
 *   (`[seed] ✓ migrated 3 rows↓ tests/a.int.test.ts (…)`). So the mark is not
 *   anchored to the line start, the path may not contain a mark, and the path is
 *   the one after the LAST mark.
 * - A stack trace or message can quote a result line. So the result must END
 *   the line: `(…)`, an optional duration, nothing else.
 *
 * Named limit: a line whose glued-in output itself ends with a whole quoted
 * result line is still read as one. The reporter never writes that.
 *
 * Pure; unit-tested in tests/unit/ci/integrationResultLines.test.ts. The CLI is
 * result-lines.ts.
 */

export interface ResultLine {
  mark: string;
  file: string;
  total: number;
  /** `failed`, `skipped`, `todo`, … as vitest prints them after the total. */
  counts: Record<string, number>;
}

const RESULT = /[✓❯↓×] ([^✓❯↓×\s][^✓❯↓×]*?\.test\.ts) \((\d+) tests?((?: \| \d+ [a-z]+)*)\)(?: \d+(?:\.\d+)?m?s)?\s*$/u;
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

/** The failing files (❯ or ×), one normalised line each, as the run's summary prints them. */
export function failingLines(lines: ResultLine[]): string[] {
  return lines.filter((r) => r.mark === '❯' || r.mark === '×').map((r) => {
    const extra = Object.entries(r.counts).map(([k, v]) => ` | ${v} ${k}`).join('');
    return ` ${r.mark} ${r.file} (${r.total} test${r.total === 1 ? '' : 's'}${extra})`;
  });
}
