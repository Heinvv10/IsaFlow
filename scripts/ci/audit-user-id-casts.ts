/**
 * audit-user-id-casts — CI entrypoint for the `text = uuid` guard.
 *
 * Detection logic lives in ./userIdCastRules.ts so it can be unit-tested; this
 * file only walks the tree and reports. See tests/unit/ci/userIdCastRules.test.ts.
 *
 * Run: bun scripts/ci/audit-user-id-casts.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findViolations } from './userIdCastRules';

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

const found: Array<{ file: string; line: number; rule: string; snippet: string }> = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('::UUID') && !text.includes('users')) continue;
    for (const v of findViolations(text)) found.push({ file, ...v });
  }
}

console.log('=== user identity is a string: no ::UUID casts on user_id / users.id ===');
if (found.length > 0) {
  console.error(
    `ERROR: ${found.length} user-identity type violation(s). ` +
    'Postgres has no text = uuid operator — these throw at runtime, not compile time.'
  );
  for (const v of found) {
    console.error(`  ${v.file}:${v.line}\n      ${v.rule}\n      ${v.snippet}`);
  }
  process.exit(1);
}
console.log('OK: no ::UUID casts against string user-identity columns.');
