/**
 * check-font-mono-allowlist: eslint/font-mono-allowlist.json may only shrink. tests/unit/ci/fontMonoCensus.test.ts
 * runs this gate in the unit suite; the CLI exists for `--write`.
 *
 * Run:   bun scripts/ci/check-font-mono-allowlist.ts
 * Prune: bun scripts/ci/check-font-mono-allowlist.ts --write   (lowers counts and drops fixed files; never adds a
 *        file or raises a count, and is refused in CI.)
 *
 * scripts/ is outside `bun run lint`, and this CLI reports through the console: that is its output.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FONT_MONO_LIST, fontMonoCounts, trackedSources } from './fontMonoCensus';
import { runGate, type Counts } from './rawInputAllowlist';

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const sorted = (counts: Counts): Counts => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

process.exit(await runGate({
  env: process.env,
  writing: process.argv.includes('--write'),
  git,
  actualCounts: async () => fontMonoCounts(trackedSources(git), (f) => readFileSync(f, 'utf8')),
  readList: () => (existsSync(FONT_MONO_LIST.path) ? readFileSync(FONT_MONO_LIST.path, 'utf8') : null),
  writeList: (counts) => writeFileSync(FONT_MONO_LIST.path, `${JSON.stringify(sorted(counts), null, 2)}\n`),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  list: FONT_MONO_LIST,
}));
