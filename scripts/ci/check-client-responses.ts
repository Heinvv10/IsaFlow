/**
 * check-client-responses — CI entrypoint: client code must look at the HTTP status before it trusts a
 * response body, say what failed in a plain sentence, not leak raw error text, and check every write.
 *
 * Rule, classes (a-g) and STATED LIMITS: ./clientResponseRule.ts. Fixtures and mutations:
 * tests/unit/ci/clientResponseRule*.test.ts. Pins (the only accepted exceptions): ./client-responses.pins.json,
 * each { file, kind, line (trimmed text), count (default 1), reason }. Fail-closed:
 *   - an empty file list, a file the parser cannot read, or a file outside the program fails;
 *   - a hit not covered by a pin fails; a pin matching MORE hits than its count fails; a stale pin fails;
 *   - a pin needs a real reason (3+ words, 20+ characters).
 * Client files are chosen by CONTENT (./clientResponseSelect.ts): imports and identifiers, not words in comments.
 * Run: bun scripts/ci/check-client-responses.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyzePaths, type Hit } from './clientResponseRule';
import { selectClientFiles } from './clientResponseSelect';

const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 27 }).split('\n').filter(Boolean);
const tracked = [...new Set([...git(['ls-files']), ...git(['ls-files', '-o', '--exclude-standard'])])]
  .filter((f) => /\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f));
const files = selectClientFiles(tracked, (f) => readFileSync(f, 'utf8'));

interface Pin { file: string; kind: string; line: string; count?: number; reason: string }
const pins: Pin[] = JSON.parse(readFileSync('scripts/ci/client-responses.pins.json', 'utf8'));
console.log('=== client code checks the response status, says what failed, and checks its writes ===');
const errors: string[] = [];
if (files.length === 0) errors.push('no client files were selected: the file selection is broken (this gate must never pass on nothing)');
for (const p of pins) if (!p.reason || p.reason.trim().length < 20 || p.reason.trim().split(/\s+/).length < 3) errors.push(`pin without a real reason: ${p.file} ${p.line}`);

const analysis = files.length ? analyzePaths(files) : { hits: [] as Hit[], parseErrors: [] as string[] };
for (const e of analysis.parseErrors) errors.push(e);
const key = (h: { file: string; kind: string; lineText?: string; line?: string }) => `${h.file}\u0000${h.kind}\u0000${h.lineText ?? h.line}`;
const allowed = new Map(pins.map((p) => [key(p), p.count ?? 1]));
const found = new Map<string, Hit[]>();
for (const h of analysis.hits) found.set(key(h), [...(found.get(key(h)) ?? []), h]);
const unpinned: Hit[] = [];
for (const [k, hs] of found) { const n = allowed.get(k) ?? 0; if (hs.length > n) unpinned.push(...hs.slice(n)); }
for (const p of pins) { const n = found.get(key(p))?.length ?? 0; if (n === 0) errors.push(`stale pin (matches nothing any more, delete it): ${p.file} [${p.kind}] ${p.line}`); }
if (unpinned.length) {
  errors.push(`${unpinned.length} unpinned hit(s):`);
  for (const h of unpinned) errors.push(`  ${h.file}:${h.line}  [${h.kind}] ${h.reason}\n      ${h.lineText}`);
  errors.push("Fix: await assertOk(res, '<plain sentence>') before reading the body; show apiErrorMessage(err, '<same sentence>'); check every write.");
  errors.push('Pin it in scripts/ci/client-responses.pins.json ONLY if the line is a true false positive, with a reason.');
}
if (errors.length) { for (const e of errors) console.error(e.startsWith('  ') || e.startsWith('Fix') || e.startsWith('Pin') ? e : `ERROR: ${e}`); process.exit(1); }
console.log(`OK: ${files.length} client files, ${pins.length} pin(s), no new hit.`);
