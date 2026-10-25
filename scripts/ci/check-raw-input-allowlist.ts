/**
 * check-raw-input-allowlist — the raw-input allowlist may only shrink.
 *
 * eslint/raw-input-allowlist.json lists the files that still use a raw <input type="date"> or an
 * unlabelled <input> (rule isaflow/no-raw-form-input). `bun run lint` stops NEW violators; this
 * gate stops the list going stale. It lints src/ and pages/ with the allowlist emptied and fails when
 *   - an allowlisted file no longer violates (or no longer exists): remove it from the list; or
 *   - a file violates and is not on the list (lint says the same, with the line).
 * Fixing a form therefore forces its entry out of the list in the same PR.
 *
 * It also compares against the list on origin/master (RAW_INPUT_BASE_REF overrides the ref): an entry that is
 * not there is a file somebody ADDED, which fails even when the rule would have let it through. When master
 * has no list yet (the PR that introduces it) the comparison is skipped and says so. With the ref itself
 * missing the gate fails on GitHub (fetch-depth 0 provides it) and warns locally.
 *
 * Inline `eslint-disable` comments are switched off here (noInlineConfig), so a disable cannot hide a
 * violating file from this gate: it has to be on the list.
 *
 * Syntax-only parse (no type information), so it takes seconds, unlike `bun run lint`. scripts/ is outside
 * `bun run lint` (which covers src and pages), and this CLI reports through the console: that is its output.
 *
 * Run:   bun scripts/ci/check-raw-input-allowlist.ts
 * Prune: bun scripts/ci/check-raw-input-allowlist.ts --write   (drops stale entries; never adds one.
 *        Delete the file first to regenerate it from the tree, which is a reviewable decision.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import isaflow from '../../eslint/isaflow-plugin.mjs';
import { ALLOWLIST_FILE } from '../../eslint/rules/no-raw-form-input.mjs';

const RULE = 'isaflow/no-raw-form-input';

async function violatingFiles(): Promise<string[]> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.tsx'],
        linterOptions: { noInlineConfig: true },
        languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { isaflow },
        rules: { [RULE]: ['error', { allowlist: [] }] },
      },
    ],
  });
  const results = await eslint.lintFiles(['src/**/*.tsx', 'pages/**/*.tsx']);
  const parseErrors = results.flatMap((r) =>
    r.messages.filter((m) => m.fatal).map((m) => `${path.relative(process.cwd(), r.filePath)}: ${m.message}`),
  );
  if (parseErrors.length > 0) throw new Error(`could not parse:\n${parseErrors.join('\n')}`);
  return results
    .filter((r) => r.messages.some((m) => m.ruleId === RULE))
    .map((r) => path.relative(process.cwd(), r.filePath).split(path.sep).join('/'))
    .sort();
}

const LIST_PATH = 'eslint/raw-input-allowlist.json';

/** The list as committed on the base ref: an array, 'no-list' when the ref has none, 'no-ref' when it is absent. */
function baseList(ref: string): string[] | 'no-list' | 'no-ref' {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' });
  } catch {
    return 'no-ref';
  }
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:${LIST_PATH}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return 'no-list';
  }
}

async function main(): Promise<number> {
  const write = process.argv.includes('--write');
  const violating = await violatingFiles();
  const exists = existsSync(ALLOWLIST_FILE);
  const listed: string[] = exists ? JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8')) : [];

  if (!exists) {
    if (!write) {
      console.error(`[raw-input-allowlist] ${path.relative(process.cwd(), ALLOWLIST_FILE)} is missing`);
      return 1;
    }
    writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(violating, null, 2)}\n`);
    console.log(`[raw-input-allowlist] wrote ${violating.length} entries`);
    return 0;
  }

  const now = new Set(violating);
  const stale = listed.filter((f) => !now.has(f));
  const unlisted = violating.filter((f) => !listed.includes(f));

  if (write) {
    writeFileSync(ALLOWLIST_FILE, `${JSON.stringify(listed.filter((f) => now.has(f)), null, 2)}\n`);
    console.log(`[raw-input-allowlist] pruned ${stale.length} stale entries`);
    return unlisted.length > 0 ? 1 : 0;
  }

  for (const f of stale) {
    console.error(`[raw-input-allowlist] STALE: ${f} no longer violates (or is gone). Remove it from eslint/raw-input-allowlist.json (bun scripts/ci/check-raw-input-allowlist.ts --write).`);
  }
  for (const f of unlisted) {
    console.error(`[raw-input-allowlist] NEW: ${f} has a raw date input or an unlabelled <input>. Use the kit (Input, MoneyField, DateField) or label it; do not add it to the allowlist.`);
  }
  const ref = process.env.RAW_INPUT_BASE_REF ?? 'origin/master';
  const base = baseList(ref);
  let added: string[] = [];
  if (base === 'no-ref') {
    const where = process.env.GITHUB_ACTIONS === 'true' ? 'FAIL' : 'warn';
    console.error(`[raw-input-allowlist] ${where}: base ref ${ref} is not available, cannot check that the list only shrinks.`);
    if (where === 'FAIL') return 1;
  } else if (base === 'no-list') {
    console.log(`[raw-input-allowlist] ${ref} has no allowlist yet: this change introduces it, nothing to compare.`);
  } else {
    added = listed.filter((f) => !base.includes(f));
    for (const f of added) {
      console.error(`[raw-input-allowlist] ADDED: ${f} is on the list but not on ${ref}. The list may only shrink: fix the file instead.`);
    }
  }
  if (stale.length + unlisted.length + added.length > 0) return 1;
  console.log(`[raw-input-allowlist] ok: ${listed.length} files still to migrate, none new, none stale`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
