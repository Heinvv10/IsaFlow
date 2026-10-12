/**
 * Which integration suites the CI integration gate saw skip, and why, in words
 * for the log.
 *
 * The gate (scripts/ci/integration/run.sh) runs every *.int.test.ts against
 * disposable databases, but a suite can still skip itself: one that needs a
 * live GoTrue, or isaflow_dev's real tenants, has nothing to run against
 * there. vitest counts a skipped suite as a pass, so a green run would not say
 * those proofs were absent. This reads vitest's own per-file result lines (the
 * outcome, not a guess from the source), and for each file that skipped
 * anything quotes the reason the file states in a `ci-integration-skip:`
 * comment.
 *
 * A file that skipped EVERY test and states no reason is `unexplained`, and
 * the gate fails on it: no suite drops out of CI silently. A file that skipped
 * only some tests is printed either way, with "no reason stated" when it has
 * no comment.
 *
 * Pure, so it is unit-tested (tests/unit/ci/skippedIntegrationSuites.test.ts);
 * report-skipped-integration.ts reads the logs and the files, and prints.
 */

export interface SkippedSuite {
  file: string;
  total: number;
  skipped: number;
  /** The file's `ci-integration-skip:` text, or null when it has none. */
  reason: string | null;
}

/** ` ✓ tests/x.int.test.ts (12 tests | 1 failed | 3 skipped) 410ms` (also ❯, ↓, ×). */
const FILE_LINE = /^ [✓❯↓×] (\S+\.test\.ts) \((\d+) tests?((?: \| \d+ [a-z]+)*)\)/u;
const MARKER = /ci-integration-skip:\s*(.+)$/m;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function skippedSuites(log: string, read: (file: string) => string | undefined): SkippedSuite[] {
  const seen = new Map<string, SkippedSuite>();
  for (const raw of log.split('\n')) {
    const m = FILE_LINE.exec(raw.replace(ANSI, ''));
    if (!m) continue;
    const skipped = Number(/\| (\d+) skipped/.exec(m[3] ?? '')?.[1] ?? 0);
    if (skipped === 0) continue;
    const file = m[1]!;
    const reason = MARKER.exec(read(file) ?? '')?.[1]?.trim() ?? null;
    seen.set(file, { file, total: Number(m[2]), skipped, reason });
  }
  return [...seen.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function skipNotice(suites: SkippedSuite[]): { lines: string[]; unexplained: string[] } {
  const unexplained = suites.filter((s) => s.skipped === s.total && !s.reason).map((s) => s.file);
  const lines = suites.map((s) => {
    const what = s.skipped === s.total ? `all ${s.total} tests skipped` : `${s.skipped} of ${s.total} tests skipped`;
    return `[skip] ${s.file}: ${what} — ${s.reason ?? 'no reason stated in the file'}`;
  });
  if (unexplained.length > 0) {
    lines.push(`[skip] FAIL: ${unexplained.length} suite(s) skipped every test without a "ci-integration-skip: <why>" `
      + 'comment saying why. State the reason in the file, or make the suite run:');
    lines.push(...unexplained.map((f) => `[skip]   ${f}`));
  }
  return { lines, unexplained };
}
