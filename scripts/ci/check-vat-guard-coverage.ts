/**
 * Fail the build when a file decides a VAT claim without going through a guard.
 *
 * The rule lives in `vatGuardRules.ts` and is unit-tested; this file walks the
 * tree, applies the allowlist, and reports. Read that module for why the
 * pattern is a defect and why imports — not mentions — are what satisfy it.
 *
 * FAILS CLOSED, like its siblings: it asserts it scanned a plausible number of
 * files and exits non-zero if it did not, so a broken walk cannot report PASS.
 * It also fails on a STALE allowlist entry — a path that no longer exists, or
 * one that has since started importing a guard — because an allowlist nobody
 * prunes is how a gate quietly stops gating.
 *
 * Run: bun scripts/ci/check-vat-guard-coverage.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inspectVatGuardCoverage, kindsNotExcused } from './vatGuardRules';
import { ALLOWED } from './vatGuardAllowlist';

const ROOT = join(import.meta.dir ?? __dirname, '..', '..');
const SCAN_DIRS = ['src', 'pages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'coverage', '.git']);
const MIN_FILES_EXPECTED = 200;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    // `.ts` only, deliberately. A `.tsx` page cannot post a journal — it calls
    // an API, which calls a service, and the service is what this gate governs.
    // Scanning components adds form defaults like `vatType: 'standard'` on a
    // blank credit-note line, which are not claims anyone posted; allowlisting
    // those would pad the list with entries that are not really exemptions.
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const files: string[] = [];
for (const dir of SCAN_DIRS) {
  const full = join(ROOT, dir);
  if (existsSync(full)) walk(full, files);
}

if (files.length < MIN_FILES_EXPECTED) {
  console.error(
    `[vat-guard] scanned only ${files.length} files (expected >= ${MIN_FILES_EXPECTED}).`
    + ' The walk is broken — refusing to report a pass.',
  );
  process.exit(1);
}

const unguarded: Array<{ rel: string; kinds: string[] }> = [];
const beyondEntry: Array<{ rel: string; kinds: string[] }> = [];
const seenAllowed = new Set<string>();
const nowGuarded: string[] = [];

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  const finding = inspectVatGuardCoverage(readFileSync(file, 'utf8'));
  if (!finding) continue;
  const entry = ALLOWED[rel];
  if (entry) {
    seenAllowed.add(rel);
    const extra = kindsNotExcused(finding, entry.kinds);
    if (extra.length > 0) beyondEntry.push({ rel, kinds: extra });
    // An allowlisted file that has since started guarding no longer needs the
    // exemption. Reported so the list shrinks instead of ossifying.
    if (finding.guarded) nowGuarded.push(rel);
    continue;
  }
  if (!finding.guarded) unguarded.push({ rel, kinds: finding.kinds });
}

const stale = Object.keys(ALLOWED).filter((rel) => !seenAllowed.has(rel));
let failed = false;

if (unguarded.length > 0) {
  failed = true;
  console.error('[vat-guard] These decide or forward a VAT claim without a guard:\n');
  for (const { rel, kinds } of unguarded) {
    console.error(`  ${rel}\n    matched: ${kinds.join(', ')}`);
  }
  console.error(
    '\n  Route it through gl/ruleVatResolution (or the denial funnel), or add it'
    + '\n  to ALLOWED in vatGuardAllowlist.ts WITH the reason it is attended or decides no'
    + '\n  claim. Four unattended posters reached production one at a time; this'
    + '\n  gate exists so the fifth does not.\n',
  );
}

if (beyondEntry.length > 0) {
  failed = true;
  console.error('[vat-guard] Allowlisted paths doing VAT work their entry does not excuse:\n');
  for (const { rel, kinds } of beyondEntry) console.error(`  ${rel}\n    not excused: ${kinds.join(', ')}`);
  console.error('\n  Guard the new code, or argue the new kind in its ALLOWED entry.\n');
}

if (stale.length > 0) {
  failed = true;
  console.error('[vat-guard] Allowlisted paths that no longer match the rule:\n');
  for (const rel of stale) console.error(`  ${rel}`);
  console.error('\n  Deleted, renamed, or no longer doing VAT work — remove the entry.\n');
}

if (nowGuarded.length > 0) {
  failed = true;
  console.error('[vat-guard] Allowlisted paths that now import a guard:\n');
  for (const rel of nowGuarded) console.error(`  ${rel}`);
  console.error('\n  They no longer need the exemption — remove the entry.\n');
}

if (failed) process.exit(1);
console.log(
  `[vat-guard] OK — ${files.length} files scanned, `
  + `${Object.keys(ALLOWED).length} attended/no-claim paths allowlisted.`,
);
