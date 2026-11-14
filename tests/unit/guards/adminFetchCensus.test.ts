/**
 * Admin UI census: every call to /api/admin must go through `adminFetch`.
 *
 * SOURCE-TEXT RATCHET. `withAdmin` rejects any non-GET without `X-Admin-Request`,
 * and a page that forgets it shows a dead button (SARS set-current/deprecate/import,
 * ConvertTrialModal, webhook Redeliver, Cancel subscription were all 403ing). This
 * pins the BY-CALL rule: a `fetch(`/`apiFetch(` call whose first argument names
 * /api/admin (or is the bare variable `url`) fails, wherever else in the file
 * `adminFetch` appears. `apiJson` cannot use adminFetch, so its non-GET calls to
 * /api/admin must carry the header in the call itself. GETs are held to the same
 * rule for consistency.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CALLEE = /(?<![\w.])(fetch|apiFetch|apiJson)\(/g;

/** Text of the call's arguments, up to its balanced closing paren. */
function callArgs(src: string, from: number): string {
  let depth = 1;
  let i = from;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
  }
  return src.slice(from, i - 1);
}

/** One line per offending call: `<line>: <callee>(...)`. */
export function adminFetchViolations(src: string): string[] {
  const bad: string[] = [];
  for (const m of src.matchAll(CALLEE)) {
    const args = callArgs(src, m.index + m[0].length);
    const first = args.split(',')[0] + args.slice(0, 160);
    const toAdmin = first.includes('/api/admin') || /^\s*url\s*[,)]?/.test(args);
    if (!toAdmin) continue;
    const isJson = m[1] === 'apiJson';
    const nonGet = /method/.test(args) && !/method:\s*['"]GET['"]/.test(args);
    if (isJson && (!nonGet || args.includes('X-Admin-Request'))) continue;
    bad.push(`${src.slice(0, m.index).split('\n').length}: ${m[1]}(${args.slice(0, 60).replace(/\s+/g, ' ')}`);
  }
  return bad;
}

function adminUiFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'pages/admin', 'src/components/admin', 'src/hooks'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => /\.tsx?$/.test(f));
}

describe('adminFetchViolations (the scanner)', () => {
  it('flags apiFetch to /api/admin, even when adminFetch is used elsewhere in the file', () => {
    const src = `adminFetch('/api/admin/a');\nawait apiFetch('/api/admin/x', { method: 'POST' });`;
    expect(adminFetchViolations(src)).toHaveLength(1);
  });
  it('flags a multi-line call and a bare url variable', () => {
    expect(adminFetchViolations("apiFetch(\n  `/api/admin/b/${id}`,\n  { method: 'POST' })")).toHaveLength(1);
    expect(adminFetchViolations("apiFetch(url, { method })")).toHaveLength(1);
  });
  it('allows adminFetch, non-admin routes, and apiJson that sends the header', () => {
    expect(adminFetchViolations("adminFetch('/api/admin/a', { method: 'POST' }); apiFetch('/api/features/check');")).toEqual([]);
    expect(adminFetchViolations("apiJson('/api/admin/u/1/impersonate', { method: 'POST', headers: { 'X-Admin-Request': 'true' } })")).toEqual([]);
    expect(adminFetchViolations("apiJson('/api/admin/u/1/impersonate', { method: 'POST' })")).toHaveLength(1);
  });
});

describe('admin UI files', () => {
  const files = adminUiFiles();
  it('finds the admin UI (guards against an empty census)', () => {
    expect(files.length).toBeGreaterThan(30);
  });
  it('no call to /api/admin bypasses adminFetch', () => {
    const offenders = files.flatMap((f) => adminFetchViolations(readFileSync(f, 'utf8')).map((v) => `${f}:${v}`));
    expect(offenders).toEqual([]);
  });
});
