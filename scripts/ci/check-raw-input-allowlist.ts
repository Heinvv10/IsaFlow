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
 *     refuses the override) an entry was ADDED or a
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
import { compareCounts, parseCounts, pruneCounts, readBaseList, resolveBaseRef, type Counts } from './rawInputAllowlist';

const RULE = 'isaflow/no-raw-form-input';
const LIST_PATH = 'eslint/raw-input-allowlist.json';

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
const write = (counts: Counts): void => writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(counts, null, 2)}\n`);

async function main(): Promise<number> {
  const writing = process.argv.includes('--write');
  const actual = await actualCounts();

  if (!existsSync(ALLOWLIST_FILE)) {
    if (!writing) {
      console.error(`[raw-input-allowlist] ${LIST_PATH} is missing`);
      return 1;
    }
    write(actual);
    console.log(`[raw-input-allowlist] wrote ${Object.keys(actual).length} entries`);
    return 0;
  }
  const listed = parseCounts(readFileSync(ALLOWLIST_FILE, 'utf8'), LIST_PATH);

  if (writing) {
    const pruned = pruneCounts(listed, actual);
    write(pruned);
    const stillBad = compareCounts(pruned, actual, null, '').filter((p) => !p.startsWith('SHRUNK'));
    console.log(`[raw-input-allowlist] pruned: ${Object.keys(pruned).length} files left`);
    stillBad.forEach((p) => console.error(`[raw-input-allowlist] ${p}`));
    return stillBad.length > 0 ? 1 : 0;
  }

  const resolved = resolveBaseRef(process.env);
  if (!resolved.ok) {
    console.error(`[raw-input-allowlist] FAIL: ${resolved.reason}`);
    return 1;
  }
  const ref = resolved.ref;
  const base = readBaseList(ref, LIST_PATH, git);
  if (base.kind === 'no-ref') {
    const where = process.env.GITHUB_ACTIONS === 'true' ? 'FAIL' : 'warn';
    console.error(`[raw-input-allowlist] ${where}: base ref ${ref} is not available, cannot check that the list only shrinks.`);
    if (where === 'FAIL') return 1;
  } else if (base.kind === 'no-list') {
    console.log(`[raw-input-allowlist] ${ref} has no allowlist yet: this change introduces it, nothing to compare.`);
  }
  const problems = compareCounts(listed, actual, base.kind === 'list' ? base.counts : null, ref);
  problems.forEach((p) => console.error(`[raw-input-allowlist] ${p}`));
  if (problems.length > 0) return 1;
  const total = Object.values(listed).reduce((a, b) => a + b, 0);
  console.log(`[raw-input-allowlist] ok: ${Object.keys(listed).length} files (${total} reports) still to migrate, none new, none stale`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
