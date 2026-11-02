/**
 * check-raw-input-allowlist — the raw-input and unnamed-control allowlists may only shrink.
 *
 * Both lists are checked in one ESLint run, each by the same rules below: eslint/raw-input-allowlist.json for
 * isaflow/no-raw-form-input and eslint/unnamed-control-allowlist.json for isaflow/no-unnamed-control (<select>,
 * <textarea>). The text below speaks of the first; the second behaves the same.
 *
 * eslint/raw-input-allowlist.json maps each file that still uses a raw <input type="date"> or an unlabelled
 * <input> (rule isaflow/no-raw-form-input) to how many reports it has. `bun run lint` fails a file that goes
 * past its count; this gate lints src/ and pages/ with the allowlist emptied and fails when
 *   - a file is not on the list but violates (NEW), or has more than its count (GROWN);
 *   - a file has fewer than its count (SHRUNK) or none or is gone (STALE): lower or remove the entry, so
 *     fixing a form forces the list down in the same PR;
 *   - an entry was ADDED, or a count RAISED, compared with the list on the base ref. The base is
 *     origin/master; RAW_INPUT_BASE_REF overrides it locally and is refused in CI. It is resolved before the
 *     ESLint run, so a refusal is instant. When master has no list at that path (the PR that introduces it)
 *     the comparison is skipped and says so; any other git failure, or a base list that does not parse,
 *     fails the gate. With the base ref itself missing the gate fails in CI (fetch-depth 0 provides it)
 *     and warns locally.
 *
 * The whole flow is `runGate` in ./rawInputAllowlist.ts; this file only wires ESLint, git and the file system.
 *
 * Inline `eslint-disable` comments are switched off here (noInlineConfig), so a disable cannot hide a
 * violating file from this gate: it has to be on the list.
 *
 * Syntax-only parse (no type information), so it takes seconds, unlike `bun run lint`. scripts/ is outside
 * `bun run lint` (which covers src and pages), and this CLI reports through the console: that is its output.
 *
 * Run:   bun scripts/ci/check-raw-input-allowlist.ts
 * Prune: bun scripts/ci/check-raw-input-allowlist.ts --write   (lowers counts and drops fixed files; never
 *        adds a file or raises a count. It does not read the base ref, so a local RAW_INPUT_BASE_REF is
 *        ignored, but in CI it is refused like on a plain run. Delete the file first to regenerate it from
 *        the tree, which is a reviewable decision.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import isaflow from '../../eslint/isaflow-plugin.mjs';
import { ALLOWLIST_FILE } from '../../eslint/rules/no-raw-form-input.mjs';
import { UNNAMED_CONTROL_ALLOWLIST_FILE } from '../../eslint/rules/no-unnamed-control.mjs';
import { runGate, RAW_INPUT_LIST, UNNAMED_CONTROL_LIST, type Counts, type ListSpec } from './rawInputAllowlist';

const RULES = ['isaflow/no-raw-form-input', 'isaflow/no-unnamed-control'] as const;
type Rule = (typeof RULES)[number];

/** Reports per rule and file with the allowlists emptied (files with none are absent). */
async function lintCounts(): Promise<Record<Rule, Counts>> {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.tsx'],
        linterOptions: { noInlineConfig: true },
        languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { isaflow },
        rules: Object.fromEntries(RULES.map((r) => [r, ['error', { allowlist: {} }]])),
      },
    ],
  });
  const results = await eslint.lintFiles(['src/**/*.tsx', 'pages/**/*.tsx']);
  const parseErrors = results.flatMap((r) =>
    r.messages.filter((m) => m.fatal).map((m) => `${path.relative(process.cwd(), r.filePath)}: ${m.message}`),
  );
  if (parseErrors.length > 0) throw new Error(`could not parse:\n${parseErrors.join('\n')}`);
  const perRule = (rule: Rule): Counts => {
    const counts: Counts = {};
    for (const r of results) {
      const n = r.messages.filter((m) => m.ruleId === rule).length;
      if (n > 0) counts[path.relative(process.cwd(), r.filePath).split(path.sep).join('/')] = n;
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
  };
  return { [RULES[0]]: perRule(RULES[0]), [RULES[1]]: perRule(RULES[1]) } as Record<Rule, Counts>;
}

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// One ESLint run, started on first use: a refused base ref still fails before it.
let linted: Promise<Record<Rule, Counts>> | undefined;
const countsFor = (rule: Rule) => async (): Promise<Counts> => (await (linted ??= lintCounts()))[rule];

const gate = (rule: Rule, list: ListSpec, file: string): Promise<number> =>
  runGate({
    env: process.env,
    writing: process.argv.includes('--write'),
    git,
    actualCounts: countsFor(rule),
    readList: () => (existsSync(file) ? readFileSync(file, 'utf8') : null),
    writeList: (counts) => writeFileSync(file, `${JSON.stringify(counts, null, 2)}\n`),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    list,
  });

(async () => {
  const a = await gate(RULES[0], RAW_INPUT_LIST, ALLOWLIST_FILE);
  const b = await gate(RULES[1], UNNAMED_CONTROL_LIST, UNNAMED_CONTROL_ALLOWLIST_FILE);
  return Math.max(a, b);
})().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
