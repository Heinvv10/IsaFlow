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
 * Syntax-only parse (no type information), so it takes seconds, unlike `bun run lint`.
 *
 * Run:   bun scripts/ci/check-raw-input-allowlist.ts
 * Prune: bun scripts/ci/check-raw-input-allowlist.ts --write   (drops stale entries; never adds one.
 *        Delete the file first to regenerate it from the tree, which is a reviewable decision.)
 */
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
  if (stale.length + unlisted.length > 0) return 1;
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
