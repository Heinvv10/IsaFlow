/**
 * report-skipped-integration — prints which integration suites the CI
 * integration gate saw skip, and why; exits 1 when a suite skipped every test
 * without saying why. The rules live in ./skippedIntegrationSuites.ts.
 *
 * Also names the tests/integration files the gate does not run at all: it
 * runs *.int.test.ts only, and the older *.test.ts files there (several drive
 * a running server over HTTP) are run by hand with `bun run test:integration`.
 *
 * Run: bun scripts/ci/report-skipped-integration.ts <vitest log>...
 * (scripts/ci/integration/run.sh passes every shard's log.)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { skipNotice, skippedSuites } from './skippedIntegrationSuites';

const read = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

const logs = process.argv.slice(2).map((f) => readFileSync(f, 'utf8')).join('\n');
const { lines, unexplained } = skipNotice(skippedSuites(logs, read));

const notRun = readdirSync('tests/integration', { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.test.ts') && !f.endsWith('.int.test.ts'))
  .map((f) => join('tests/integration', f))
  .sort();
if (notRun.length > 0) {
  lines.push(`[skip] not part of this gate (it runs *.int.test.ts only; run these with bun run test:integration): `
    + `${notRun.length} file(s)`);
  lines.push(...notRun.map((f) => `[skip]   ${f}`));
}

for (const line of lines) process.stdout.write(`${line}\n`);
process.exit(unexplained.length > 0 ? 1 : 0);
