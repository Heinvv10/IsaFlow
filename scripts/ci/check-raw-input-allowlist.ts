/**
 * check-raw-input-allowlist — the raw-input allowlist may only shrink.
 *
 * eslint/raw-input-allowlist.json maps each file that still uses a raw <input type="date"> or an unlabelled
 * <input> (rule isaflow/no-raw-form-input) to how many reports it has. `bun run lint` fails a file that goes
 * past its count; this gate lints src/ and pages/ with the allowlist emptied and fails when
 *   - a file is not on the list but violates (NEW), or has more than its count (GROWN);
 *   - a file has fewer than its count (SHRUNK) or none or is gone (STALE): lower or remove the entry, so
 *     fixing a form forces the list down in the same PR;
 *   - against the list on origin/master (RAW_INPUT_BASE_REF overrides the ref locally; on GitHub the gate
 *     refuses the override). The base ref is resolved before the ESLint run, so a refusal is instant. The
 *     whole flow is `runGate` in ./rawInputAllowlist.ts; this file only wires ESLint, git and the file system. an entry was ADDED or a
 *     count RAISED. When master has no list at that path (the PR that introduces it) the comparison is
 *     skipped and says so; any other git failure, or a base list that does not parse, fails the gate.
 *     With the ref itself missing the gate fails on GitHub (fetch-depth 0 provides it) and warns locally.
 *
 * Inline `eslint-disable` comments are switched off here (noInlineConfig), so a disable cannot hide a
 * violating file from this gate: it has to be on the list. The comparison logic is in ./rawInputAllowlist.ts.
 *
 * Syntax-only parse (no type information), so it takes seconds, unlike `bun run lint`. scripts/ is outside
 * `bun run lint` (which covers src and pages), and this CLI reports through the console: that is its output.
 *
 * Run:   bun scripts/ci/check-raw-input-allowlist.ts
 * Prune: bun scripts/ci/check-raw-input-allowlist.ts --write   (lowers counts and drops fixed files; never
 *        adds a file or raises a count. Delete the file first to regenerate it from the tree, which is a
 *        reviewable decision.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import isaflow from '../../eslint/isaflow-plugin.mjs';
import { ALLOWLIST_FILE } from '../../eslint/rules/no-raw-form-input.mjs';
import { runGate, type Counts } from './rawInputAllowlist';

const RULE = 'isaflow/no-raw-form-input';

/** Reports per file with the allowlist emptied (files with none are absent). */
async function actualCounts(): Promise<Counts> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.tsx'],
        linterOptions: { noInlineConfig: true },
        languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { isaflow },
        rules: { [RULE]: ['error', { allowlist: {} }] },
      },
    ],
  });
  const results = await eslint.lintFiles(['src/**/*.tsx', 'pages/**/*.tsx']);
  const parseErrors = results.flatMap((r) =>
    r.messages.filter((m) => m.fatal).map((m) => `${path.relative(process.cwd(), r.filePath)}: ${m.message}`),
  );
  if (parseErrors.length > 0) throw new Error(`could not parse:\n${parseErrors.join('\n')}`);
  const counts: Counts = {};
  for (const r of results) {
    const n = r.messages.filter((m) => m.ruleId === RULE).length;
    if (n > 0) counts[path.relative(process.cwd(), r.filePath).split(path.sep).join('/')] = n;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

runGate({
  env: process.env,
  writing: process.argv.includes('--write'),
  git,
  actualCounts,
  readList: () => (existsSync(ALLOWLIST_FILE) ? readFileSync(ALLOWLIST_FILE, 'utf8') : null),
  writeList: (counts) => writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(counts, null, 2)}\n`),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
}).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
