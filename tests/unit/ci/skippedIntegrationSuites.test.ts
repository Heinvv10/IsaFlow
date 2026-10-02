/**
 * THE CI LOG NAMES THE INTEGRATION SUITES IT DID NOT RUN, AND WHY.
 *
 * Three suites (pack-routes-access, report-pack-cash-flows,
 * statutory-filings-as-at) seed whole companies and so run only against a
 * disposable database on this machine; anywhere else they `describe.skip`.
 * GitHub's runner has no database at all, so `bun run ci` printed one line —
 * "integration-tests: DATABASE_URL not set" — and a reader of a green run had
 * no way to tell that the pack's real-database proofs were not in it.
 */
import { describe, expect, it } from 'vitest';
import { skippedIntegrationNotice, type IntegrationSuite } from '../../../scripts/ci/skippedIntegrationSuites';

const SUITES: IntegrationSuite[] = [
  { file: 'tests/integration/pack-routes-access.int.test.ts', disposableOnly: true },
  { file: 'tests/integration/statutory-filings-as-at.int.test.ts', disposableOnly: true },
  { file: 'tests/integration/journal-posting.int.test.ts', disposableOnly: false },
];

describe('with no DATABASE_URL', () => {
  const lines = skippedIntegrationNotice(undefined, SUITES);

  it('says every integration suite was skipped, how many, and why', () => {
    expect(lines[0]).toBe('[skip] integration-tests: DATABASE_URL not set — none of the 3 integration suites ran.');
  });

  it('names each suite that needs a disposable database', () => {
    expect(lines).toContain('[skip]   tests/integration/pack-routes-access.int.test.ts');
    expect(lines).toContain('[skip]   tests/integration/statutory-filings-as-at.int.test.ts');
    expect(lines.join('\n')).not.toContain('journal-posting');
  });

  it('reads an empty string, which is what an unset GitHub secret is, the same way', () => {
    expect(skippedIntegrationNotice('', SUITES)).toEqual(lines);
  });
});

describe('with a DATABASE_URL that is not a disposable database', () => {
  const lines = skippedIntegrationNotice('postgres://app:hunter2@db.internal:5432/isaflow_dev', SUITES);

  it('says the other suites ran and these two did not, by name', () => {
    expect(lines[0]).toMatch(/^\[skip\] integration-tests: 2 of the 3 integration suites did NOT run/);
    expect(lines).toContain('[skip]   tests/integration/pack-routes-access.int.test.ts');
    expect(lines).toContain('[skip]   tests/integration/statutory-filings-as-at.int.test.ts');
  });

  it('says what would make them run', () => {
    expect(lines.join('\n')).toMatch(/isaflow_schema_fixture or isaflow_test on localhost/);
  });

  it('does not print the connection string', () => {
    expect(lines.join('\n')).not.toMatch(/hunter2|db\.internal/);
  });
});

describe('with a disposable database', () => {
  it.each([
    'postgres://postgres:pw@localhost:55432/isaflow_schema_fixture',
    'postgres://postgres:pw@127.0.0.1:5432/isaflow_test',
  ])('has nothing to report for %s', (url) => {
    expect(skippedIntegrationNotice(url, SUITES)).toEqual([]);
  });
});
