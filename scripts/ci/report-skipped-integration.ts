/**
 * report-skipped-integration — prints which integration suites the CI
 * integration gate saw skip, and why; exits 1 when a suite skipped every test
 * without saying why. The rules live in ./skippedIntegrationSuites.ts.
 *
 * Also names the tests/integration files the gate does not run at all: it
 * runs *.int.test.ts only, and the older *.test.ts files there (several drive
 * a running server over HTTP) are run by hand with `bun run test:integration`.
 *
 * A log's sibling `<name>.started` (startedFileReporter.ts, beside
 * `<name>.log`) lists the suites that started; one of them with no readable
 * result line in that log also fails the report, by name: whether it skipped
 * cannot be told. A log without that list fails the report too, by name: its
 * suites could not be checked; except a log holding only shard.sh's "TIMED
 * OUT before it started" line, which gets one plain line (no suite started,
 * and shard.sh has already failed the run).
 *
 * Run: bun scripts/ci/report-skipped-integration.ts <vitest log>...
 * (scripts/ci/integration/run.sh passes every shard's log.)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resultLines, unreadable } from './integration/resultLines';
import { skipNotice, skippedSuites } from './skippedIntegrationSuites';

const read = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

const files = process.argv.slice(2);
const logs = files.map((f) => readFileSync(f, 'utf8'));
/** Every non-empty line is shard.sh's "TIMED OUT before it started" note. */
const onlyTimedOutBeforeStart = (log: string): boolean => {
  const nonEmpty = log.split('\n').filter((l) => l.trim() !== '');
  return nonEmpty.length > 0 && nonEmpty.every((l) => /^\[integration\] shard \d+\/\d+ \S+: TIMED OUT before it started /.test(l));
};
const lines: string[] = [];
const noList: string[] = [];
const unread = files.flatMap((f, i) => {
  const started = f.replace(/\.log$/, '.started');
  if (started === f) {
    noList.push(`[skip] FAIL: no started-file list for ${f} (expected a sibling <name>.started)`);
    return [];
  }
  if (!existsSync(started) && onlyTimedOutBeforeStart(logs[i]!)) {
    lines.push(`[skip] ${f}: the shard timed out before any suite started; no suite to check`);
    return [];
  }
  if (!existsSync(started)) {
    noList.push(`[skip] FAIL: no started-file list for ${f} (expected ${started})`);
    return [];
  }
  return unreadable(resultLines(logs[i]!), readFileSync(started, 'utf8').split('\n'), process.cwd());
});
const notice = skipNotice(skippedSuites(logs.join('\n'), read), unread);
const { unexplained, unreadable: unknown } = notice;
lines.unshift(...notice.lines);
lines.push(...noList);

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
process.exit(unexplained.length > 0 || unknown.length > 0 || noList.length > 0 ? 1 : 0);
