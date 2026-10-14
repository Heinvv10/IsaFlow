/**
 * result-lines — the integration gate's reader of vitest's per-file result
 * lines (rules in ./resultLines.ts).
 *
 *   bun scripts/ci/integration/result-lines.ts counts <log> <planned file>...
 *     prints `<n>\t<file>` for each planned file without exactly one result line (shard.sh)
 *   bun scripts/ci/integration/result-lines.ts failed <log> [<started list>]
 *     prints the failing files' result lines (run.sh's summary), then each file
 *     the started list (startedFileReporter.ts) names that has no readable one
 */
import { existsSync, readFileSync } from 'node:fs';
import { failingLines, resultLines, unreadable, wrongCounts } from './resultLines';

const [cmd, log, ...planned] = process.argv.slice(2);
if ((cmd !== 'counts' && cmd !== 'failed') || !log) {
  process.stderr.write('usage: result-lines.ts counts <log> <file>... | failed <log> [<started list>]\n');
  process.exit(2);
}
const lines = resultLines(readFileSync(log, 'utf8'));
const started = (file: string | undefined): string[] =>
  (file && existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []);
const out = cmd === 'counts'
  ? wrongCounts(lines, planned).map((c) => `${c.n}\t${c.file}`)
  : [...failingLines(lines), ...unreadable(lines, started(planned[0]), process.cwd())
    .map((f) => ` ? ${f} (started, but no readable result line)`)];
for (const line of out) process.stdout.write(`${line}\n`);
