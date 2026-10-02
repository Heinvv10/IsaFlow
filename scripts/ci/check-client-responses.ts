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
 * Client files are chosen by CONTENT, not by four hard-coded roots: any tracked source file (.ts/.tsx/.js/.jsx/
 * .mts/.cts/.mjs/.cjs) outside pages/api, tests, scripts and build output that calls apiFetch/apiJson/assertOk,
 * or calls fetch / axios / XMLHttpRequest / sendBeacon and is browser code (a client root, or it touches the
 * browser: window, document, localStorage, navigator, React hooks), and is not server code (NextApi*, @/lib/neon, pg).
 * Run: bun scripts/ci/check-client-responses.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyzePaths, type Hit } from './clientResponseRule';

const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 27 }).split('\n').filter(Boolean);
const tracked = [...new Set([...git(['ls-files']), ...git(['ls-files', '-o', '--exclude-standard'])])]
  .filter((f) => /\.(m|c)?[jt]sx?$/.test(f) && !/\.d\.ts$/.test(f));
const EXCLUDED = /^(pages\/api\/|tests\/|scripts\/|node_modules\/|\.next\/|\.claude\/|docs\/|e2e\/|playwright|.*\.(config|test|spec|typeproof)\.[mc]?[jt]sx?$)/;
const CLIENT_ROOT = /^(pages\/|src\/components\/|src\/hooks\/|src\/contexts\/|src\/modules\/[^/]+\/(hooks|utils|documents|components)\/|public\/|chrome-extension\/)/;
const API_HELPERS = /\b(apiFetch|apiJson|assertOk)\b/;
const RAW_TRANSPORT = /\bfetch\s*\(|\baxios\b|\bXMLHttpRequest\b|\bsendBeacon\b/;
const BROWSER = /from ['"]react['"]|['"]use client['"]|\bwindow\.(location|addEventListener|open|history)\b|\bdocument\.(cookie|addEventListener|getElementById|createElement|querySelector)\b|\b(localStorage|sessionStorage)\.|\bnavigator\.(sendBeacon|clipboard)/;
const SERVER = /\b(NextApiRequest|NextApiResponse|getServerSideProps|server-only)\b|from ['"](@\/lib\/neon|pg)['"]/;

const files = tracked.filter((f) => {
  if (EXCLUDED.test(f)) return false;
  const text = readFileSync(f, 'utf8');
  if (SERVER.test(text) && !API_HELPERS.test(text)) return false;
  if (CLIENT_ROOT.test(f) || API_HELPERS.test(text)) return true;   // a client root is scanned whether or not it names apiFetch (it may call an imported helper)
  return RAW_TRANSPORT.test(text) && BROWSER.test(text);
});

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
