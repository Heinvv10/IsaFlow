/**
 * check-client-responses — CI entrypoint: client code must look at the HTTP
 * status before it trusts a response body, say what failed in a plain sentence,
 * not leak raw error text, and never fire a write it does not check.
 *
 * Rule and its four classes (a-d): ./clientResponseRule.ts. Mutation
 * counterexamples: tests/unit/ci/clientResponseRule.test.ts. Pins (the only
 * accepted exceptions, each file + trimmed line + one-line reason):
 * ./client-responses.pins.json. Fail-closed both ways: a NEW unpinned hit fails,
 * and so does a pin that no longer matches anything (delete it).
 *
 * Files come from `git ls-files` (tracked plus untracked-not-ignored), never a
 * directory walk that could skip a symlink. Run: bun scripts/ci/check-client-responses.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyze, type Hit } from './clientResponseRule';

const SCOPES = ['pages', 'src/components', 'src/hooks', 'src/contexts'];
const listed = (args: string[]) => execFileSync('git', ['ls-files', ...args, '--', ...SCOPES], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean);
const files = [...new Set([...listed([]), ...listed(['-o', '--exclude-standard'])])]
  .filter((f) => /\.tsx?$/.test(f) && !f.startsWith('pages/api/') && !/\.d\.ts$/.test(f));

interface Pin { file: string; kind: string; line: string; reason: string }
const pins: Pin[] = JSON.parse(readFileSync('scripts/ci/client-responses.pins.json', 'utf8'));
const bad = pins.filter((p) => !p.reason || p.reason.trim().length < 12);

const hits: Hit[] = analyze(files.map((file) => ({ file, text: readFileSync(file, 'utf8') })));
const key = (h: { file: string; kind: string; lineText?: string; line?: string }) => `${h.file}\u0000${h.kind}\u0000${h.lineText ?? h.line}`;
const pinned = new Set(pins.map(key));
const unpinned = hits.filter((h) => !pinned.has(key(h)));
const live = new Set(hits.map(key));
const stale = pins.filter((p) => !live.has(key(p)));

console.log('=== client code checks the response status, says what failed, and checks its writes ===');
let fail = false;
if (bad.length) { fail = true; console.error(`ERROR: ${bad.length} pin(s) without a real reason: ${bad.map((p) => `${p.file} ${p.line}`).join(' | ')}`); }
if (unpinned.length) {
  fail = true;
  console.error(`ERROR: ${unpinned.length} unpinned hit(s):`);
  for (const h of unpinned) console.error(`  ${h.file}:${h.line}  [${h.kind}] ${h.reason}\n      ${h.lineText}`);
  console.error('\nFix: await assertOk(res, \'<plain sentence>\') before reading the body; show apiErrorMessage(err, \'<same sentence>\');');
  console.error('check every write. Pin it in scripts/ci/client-responses.pins.json ONLY if the line is a true false positive, with a reason.');
}
if (stale.length) { fail = true; console.error(`ERROR: ${stale.length} stale pin(s) match nothing any more - delete them:`); for (const p of stale) console.error(`  ${p.file} [${p.kind}] ${p.line}`); }
if (fail) process.exit(1);
console.log(`OK: ${files.length} client files, ${hits.length} pinned exception(s), no new hit.`);
