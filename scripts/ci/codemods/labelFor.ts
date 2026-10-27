/**
 * labelFor codemod — pair a `<label>` with the control right after it via htmlFor/id.
 *
 * The rules (pattern, id scheme, skips) are in ./labelForTransform.ts. This CLI only picks the files, writes
 * them, and prints a report: one line per pair, `file:line id` or `file:line SKIP <reason> (<id>)`.
 *
 * Run on files you own only (master-plan wave 2 §3):
 *   bun scripts/ci/codemods/labelFor.ts --files 'src/components/accounting/settings/*Tab.tsx' [--dry-run]
 * `--files` is a git pathspec glob (tracked files only); it may be given more than once.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { transformLabelFor } from './labelForTransform';

function args(argv: string[]): { dryRun: boolean; globs: string[] } {
  const globs: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--files' && argv[i + 1]) globs.push(argv[++i] as string);
  return { dryRun: argv.includes('--dry-run'), globs };
}

const { dryRun, globs } = args(process.argv.slice(2));
if (globs.length === 0) {
  console.error('usage: bun scripts/ci/codemods/labelFor.ts --files <glob> [--files <glob>] [--dry-run]');
  process.exit(2);
}
const files = execFileSync('git', ['ls-files', '--', ...globs.map((g) => `:(glob)${g}`)], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f.endsWith('.tsx'));

/** `<Name` tag uses of a component in tracked app .tsx files other than `self`; tests do not count (git grep exits 1 on no match). */
function usesElsewhere(name: string, self: string): number {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-c', '-E', `<${name}([[:space:]/>]|$)`, '--', '*.tsx', ':(exclude)tests/**', `:(exclude)${self}`], { encoding: 'utf8' });
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e;
  }
  return out.split('\n').filter(Boolean).reduce((n, line) => n + Number(line.slice(line.lastIndexOf(':') + 1)), 0);
}

let applied = 0;
let skipped = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const { output, pairs } = transformLabelFor(source, file, { usesElsewhere: (name) => usesElsewhere(name, file) });
  for (const p of pairs) {
    const who = p.component ? ` [${p.component}]` : '';
    if (p.skip) {
      skipped++;
      console.log(`${file}:${p.line} SKIP ${p.skip} (${p.id || 'no id'})${who}`);
    } else {
      applied++;
      console.log(`${file}:${p.line} ${p.id}${who}`);
    }
  }
  if (!dryRun && output !== source) writeFileSync(file, output);
}
console.log(`${dryRun ? 'dry run: ' : ''}${files.length} files, ${applied} pairs named, ${skipped} skipped`);
