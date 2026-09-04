/**
 * check-gl-journal-lines-scope — CI entrypoint for BL-13: every
 * gl_journal_lines query must scope by company_id.
 *
 * Detection logic lives in ./glJournalLinesScopeRule.ts so it can be
 * unit-tested; this file only walks the tree and reports. See
 * tests/unit/ci/glJournalLinesScopeRule.test.ts.
 *
 * Run: bun scripts/ci/check-gl-journal-lines-scope.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findViolations } from './glJournalLinesScopeRule';

const ROOTS = ['pages', 'src'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(p, out);
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(p);
    }
  }
  return out;
}

const found: Array<{ file: string; line: number; snippet: string }> = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('gl_journal_lines')) continue;
    for (const v of findViolations(text)) found.push({ file, ...v });
  }
}

console.log('=== BL-13: every gl_journal_lines query must scope by company_id ===');
if (found.length > 0) {
  console.error(`ERROR: ${found.length} gl_journal_lines quer${found.length === 1 ? 'y' : 'ies'} without company_id scoping.`);
  for (const v of found) {
    console.error(`  ${v.file}:${v.line}\n      ${v.snippet}`);
  }
  process.exit(1);
}
console.log('OK: gl_journal_lines usage is tenant-scoped.');
