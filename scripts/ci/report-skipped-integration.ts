/**
 * report-skipped-integration — prints which integration suites this
 * `bun run ci` did not run and why. Informational: it never fails the gate.
 * The wording lives in ./skippedIntegrationSuites.ts.
 *
 * The URL comes from CI_DATABASE_URL, which run-ci.sh sets to the DATABASE_URL
 * its own shell has: bun loads .env.local into process.env.CI_DATABASE_URL, and
 * that is not the variable run-ci.sh decided on.
 *
 * Run: CI_DATABASE_URL="${DATABASE_URL:-}" bun scripts/ci/report-skipped-integration.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { skippedIntegrationNotice } from './skippedIntegrationSuites';

const DIR = 'tests/integration';

const suites = readdirSync(DIR, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.int.test.ts'))
  .sort()
  .map((f) => join(DIR, f))
  .map((file) => ({ file, disposableOnly: readFileSync(file, 'utf8').includes('isDisposableDb(') }));

for (const line of skippedIntegrationNotice(process.env.CI_DATABASE_URL, suites)) process.stdout.write(`${line}\n`);
