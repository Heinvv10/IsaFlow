/**
 * Fail the build on raw transaction control through the `sql` helper.
 *
 * The rule lives in `rawTransactionRules.ts` and is unit-tested; this file only
 * walks the tree and reports. See that module for why the pattern is a defect.
 *
 * FAILS CLOSED. The first version of this gate was a shell script with
 * `set -uo pipefail`, a `2>/dev/null` on its grep and a `|| true` on the
 * pipeline: a failing `cd` made it print "OK" and exit 0, silently turning a
 * blocking gate into a no-op that reported PASS. This one asserts it actually
 * scanned a plausible number of files and exits non-zero if it did not.
 *
 * Run: bun scripts/ci/check-raw-transaction-control.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRawTransactionControl } from './rawTransactionRules';

const ROOT = join(import.meta.dir ?? __dirname, '..', '..');
const SCAN_DIRS = ['src', 'pages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.git']);

/**
 * `src/lib/neon.ts` is the ONE place allowed to issue these: `withTransaction`
 * opens a real transaction on a pool client it owns, which is the remedy every
 * other file is told to use.
 */
const ALLOWED = new Set([join('src', 'lib', 'neon.ts')]);

/** Below this, something is wrong with the walk itself — fail rather than pass. */
const MIN_FILES_EXPECTED = 200;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files: string[] = [];
for (const d of SCAN_DIRS) {
  const abs = join(ROOT, d);
  if (!existsSync(abs)) {
    console.error(`FAIL: scan directory '${d}' does not exist at ${abs}.`);
    console.error('The gate cannot pass without scanning. Fix the path rather than the check.');
    process.exit(1);
  }
  walk(abs, files);
}

if (files.length < MIN_FILES_EXPECTED) {
  console.error(`FAIL: only ${files.length} files scanned, expected at least ${MIN_FILES_EXPECTED}.`);
  console.error('This gate fails closed — a walk that finds almost nothing is a broken walk.');
  process.exit(1);
}

let violations = 0;
for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  if (ALLOWED.has(rel)) continue;
  for (const v of findRawTransactionControl(readFileSync(file, 'utf8'))) {
    if (violations === 0) {
      console.error('FAIL: raw transaction control through the `sql` helper.\n');
    }
    console.error(`  ${rel}:${v.line}  ${v.text}`);
    violations += 1;
  }
}

if (violations > 0) {
  console.error(`
\`sql\` routes onto the request's ALS client, so a raw COMMIT commits the WHOLE
request and destroys any enclosing savepoint — including the MCP registry's
per-tool savepoint. \`sql.query\` and \`sql.unsafe\` are the same function and
route identically.

Use withTransaction from '@/lib/neon':

    await withTransaction(async (tx) => {
      await tx\`UPDATE ...\`;
    });

It nests a SAVEPOINT when a request transaction is in flight and opens a real
one when there is none. See scripts/ci/rawTransactionRules.ts.`);
  process.exit(1);
}

console.log(`OK: no raw transaction control in ${files.length} files.`);
