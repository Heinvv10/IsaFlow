/**
 * Which disposable database each integration suite runs against, read from
 * the suite's own code, so a new suite is routed without anyone listing it.
 *
 * The gate (run.sh) creates two identical databases, because the suites guard
 * themselves by NAME and the two guards disagree:
 *
 *   - `assertNotProductionDb` (tests/helpers) allows only isaflow_dev and
 *     isaflow_test, and throws on isaflow_schema_fixture;
 *   - `assertDisposable` (mfa-impersonation-postgres.helpers.ts) allows only
 *     isaflow_schema_fixture, and throws on isaflow_test.
 *
 * A suite is routed by what its import closure (the file plus every relative
 * import it reaches, transitively) CALLS: a call to `assertNotProductionDb`
 * sends it to isaflow_test; otherwise it goes to isaflow_schema_fixture, which
 * every other guard accepts. A closure holding both guards cannot pass on
 * either database, so it is reported as a conflict and fails the gate.
 *
 * Over-approximates on purpose: a helper module that calls a guard in one
 * export routes every suite importing that module, used or not. A suite that
 * calls some OTHER guard allowing only isaflow_test is sent to the fixture
 * database and fails there loudly; it is never skipped.
 */

export type SuiteDb = 'isaflow_schema_fixture' | 'isaflow_test';

export interface SuiteRoute {
  file: string;
  db: SuiteDb | 'conflict';
}

/** Calls, not the guards' own `export function name(` definitions. */
const TEST_ONLY = /(?<!function\s)\bassertNotProductionDb\s*\(/;
const FIXTURE_ONLY = /(?<!function\s)\bassertDisposable\s*\(/;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts'];

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Join a POSIX directory and a `./` or `../` specifier. */
export function joinRelative(dir: string, spec: string): string {
  const parts = dir ? dir.split('/') : [];
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * The file and every file its relative imports reach. `read` returns a file's
 * text, or undefined when there is no such file (or it is a directory).
 */
export function importClosure(entry: string, read: (path: string) => string | undefined): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    const text = read(path);
    if (text === undefined) continue;
    seen.set(path, text);
    for (const m of text.matchAll(RELATIVE_IMPORT)) {
      const base = joinRelative(dirOf(path), m[1]!);
      const hit = EXTENSIONS.map((ext) => base + ext).find((p) => seen.has(p) || read(p) !== undefined);
      if (hit) queue.push(hit);
    }
  }
  return seen;
}

export function routeSuite(file: string, read: (path: string) => string | undefined): SuiteRoute {
  const texts = [...importClosure(file, read).values()];
  const testOnly = texts.some((t) => TEST_ONLY.test(t));
  const fixtureOnly = texts.some((t) => FIXTURE_ONLY.test(t));
  if (testOnly && fixtureOnly) return { file, db: 'conflict' };
  return { file, db: testOnly ? 'isaflow_test' : 'isaflow_schema_fixture' };
}
