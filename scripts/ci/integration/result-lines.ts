/**
 * result-lines — the integration gate's reader of vitest's per-file result
 * lines (rules in ./resultLines.ts).
 *
 *   bun scripts/ci/integration/result-lines.ts counts <log> <planned file>...
 *     prints `<n>\t<file>` for each planned file without exactly one result line (shard.sh)
 *   bun scripts/ci/integration/result-lines.ts failed <log>
 *     prints the failing files' result lines (run.sh's summary)
 */
import { readFileSync } from 'node:fs';
import { failingLines, resultLines, wrongCounts } from './resultLines';

const [cmd, log, ...planned] = process.argv.slice(2);
if ((cmd !== 'counts' && cmd !== 'failed') || !log) {
  process.stderr.write('usage: result-lines.ts counts <log> <file>... | failed <log>\n');
  process.exit(2);
}
const lines = resultLines(readFileSync(log, 'utf8'));
const out = cmd === 'counts'
  ? wrongCounts(lines, planned).map((c) => `${c.n}\t${c.file}`)
  : failingLines(lines);
for (const line of out) process.stdout.write(`${line}\n`);
