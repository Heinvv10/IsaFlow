/**
 * check-oauth-trust-flags — CI entrypoint for: nothing may undo migration
 * 693's guard on `oauth_apps.is_verified` / `is_first_party`.
 *
 * Detection logic lives in ./oauthTrustFlagRule.ts so it can be unit-tested;
 * this file walks the trees and reports. See that file's comment for why the
 * gate watches the TRIGGERS as well as the grants, and
 * tests/unit/ci/oauthTrustFlagRule.test.ts for the mutation counterexamples
 * that prove it fires.
 *
 * Text-only, no database connection, so it runs on every `bun run ci` —
 * unlike tests/integration/oauth-apps-trust-flags.int.test.ts, which is the
 * only other guard on this property and which CI skips whenever DATABASE_URL
 * is unset.
 *
 * Run: bun scripts/ci/check-oauth-trust-flags.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findHatchUsages, findGuardRegressions, TRUST_FLAG_GUC } from './oauthTrustFlagRule';

const MIGRATIONS_DIR = 'scripts/migrations/sql';
const APP_DIRS = ['src', 'pages'];
const APP_EXTS = ['.ts', '.tsx'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (APP_EXTS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

const appFiles = APP_DIRS.flatMap((d) => walk(d)).map((file) => ({
  file,
  text: readFileSync(file, 'utf8'),
}));

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: join(MIGRATIONS_DIR, f), text: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') }));

console.log('=== the oauth_apps trust flags stay unwritable by the application ===');

const hatchUsages = findHatchUsages(appFiles);
const regressions = findGuardRegressions(migrationFiles);

let fail = false;

if (hatchUsages.length > 0) {
  fail = true;
  console.error(`ERROR: ${hatchUsages.length} reference(s) to the escape hatch in application code:`);
  for (const v of hatchUsages) console.error(`  ${v.file}:${v.line}  ${v.reason}`);
  console.error('');
  console.error(`Fix: remove it. \`${TRUST_FLAG_GUC}\` is for a human deliberately changing a`);
  console.error('trust flag at a psql prompt. Application code that sets it makes the guard');
  console.error('void for every request that runs through that code path.');
}

if (regressions.length > 0) {
  fail = true;
  console.error(`ERROR: ${regressions.length} migration statement(s) after 693 undo its guard:`);
  for (const v of regressions) console.error(`  ${v.file}:${v.line}  ${v.reason}`);
  console.error('');
  console.error('Fix: do not re-grant table-level INSERT/UPDATE on oauth_apps to app_user,');
  console.error('and do not drop, disable or downgrade the guard triggers. If a schema change');
  console.error('genuinely requires one of these, it must also restore 693\'s end state — and');
  console.error('migration 693\'s own post-condition asserts that end state at apply time.');
}

if (fail) process.exit(1);
console.log(
  `OK: no application code sets the escape hatch, and no migration after 693 re-grants or weakens the guard (${appFiles.length} app files, ${migrationFiles.length} migrations).`,
);
