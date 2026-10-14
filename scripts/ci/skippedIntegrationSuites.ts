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
 * A file that skipped (or left as todo) EVERY test and states no reason is `unexplained`, and
 * the gate fails on it: no suite drops out of CI silently. A file that skipped
 * only some tests is printed either way, with "no reason stated" when it has
 * no comment.
 *
 * The reason is the FIRST `// ci-integration-skip: <why>` comment line in the
 * file, and it covers the whole file: one stated reason excuses every test the
 * file skips (intended; a file with several skip conditions states them in that
 * one line). The marker counts only as a comment line of its own.
 *
 * Named limit: this reads text, not syntax. A line inside a multi-line string
 * (a template literal) that happens to read `// ci-integration-skip: …` counts
 * as a marker too. Review is what catches that, not this regex.
 *
 * Pure, so it is unit-tested (tests/unit/ci/skippedIntegrationSuites.test.ts);
 * report-skipped-integration.ts reads the logs and the files, and prints.
 */

import { resultLines } from './integration/resultLines';

export interface SkippedSuite {
  file: string;
  total: number;
  skipped: number;
  /** The file's `ci-integration-skip:` text, or null when it has none. */
  reason: string | null;
}

/** A line that is only a `//` comment starting with the marker: not a string, not an aside. */
const MARKER = /^\s*\/\/\s*ci-integration-skip:\s*(.+)$/m;

export function skippedSuites(log: string, read: (file: string) => string | undefined): SkippedSuite[] {
  const seen = new Map<string, SkippedSuite>();
  // vitest's result lines, read as the rest of the gate reads them (integration/resultLines.ts).
  for (const r of resultLines(log)) {
    // An it.todo asserts nothing either: count it with the skipped tests.
    const skipped = (r.counts.skipped ?? 0) + (r.counts.todo ?? 0);
    if (skipped === 0) continue;
    const reason = MARKER.exec(read(r.file) ?? '')?.[1]?.trim() ?? null;
    seen.set(r.file, { file: r.file, total: r.total, skipped, reason });
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
