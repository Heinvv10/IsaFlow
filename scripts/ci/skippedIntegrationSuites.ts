/**
 * Which integration suites a `bun run ci` did not run, in words for the log.
 *
 * Some suites seed whole companies, journals and filings, so they gate on
 * `isDisposableDb` (tests/helpers/assertDisposableDb.ts) and `describe.skip`
 * anywhere else. vitest reports a skipped suite as a passing file, and
 * run-ci.sh printed a single line when DATABASE_URL was unset, so a green run
 * did not say that these proofs were absent from it. This says so, by name.
 *
 * Pure, so it is unit-tested (tests/unit/ci/skippedIntegrationSuites.test.ts);
 * report-skipped-integration.ts finds the suites and prints.
 */
import { isDisposableDb } from '../../tests/helpers/assertDisposableDb';

export interface IntegrationSuite {
  file: string;
  /** Gates itself on `isDisposableDb` and skips against any other database. */
  disposableOnly: boolean;
}

const REMEDY =
  'To run them: DATABASE_URL must name isaflow_schema_fixture or isaflow_test on localhost (a disposable database).';

export function skippedIntegrationNotice(databaseUrl: string | undefined, suites: IntegrationSuite[]): string[] {
  const disposableOnly = suites.filter((s) => s.disposableOnly).map((s) => `[skip]   ${s.file}`);

  if (!databaseUrl) {
    return [
      `[skip] integration-tests: DATABASE_URL not set — none of the ${suites.length} integration suites ran.`,
      `[skip] ${disposableOnly.length} of them run only against a disposable database, so no ordinary DATABASE_URL would have run them either:`,
      ...disposableOnly,
      `[skip] ${REMEDY}`,
    ];
  }
  if (isDisposableDb(databaseUrl) || disposableOnly.length === 0) return [];
  return [
    `[skip] integration-tests: ${disposableOnly.length} of the ${suites.length} integration suites did NOT run — `
      + 'they seed whole companies and DATABASE_URL does not name a disposable database. vitest counts them as skipped, not failed:',
    ...disposableOnly,
    `[skip] ${REMEDY}`,
  ];
}
