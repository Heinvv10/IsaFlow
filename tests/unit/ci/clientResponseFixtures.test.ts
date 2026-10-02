/**
 * The 66 evasion fixtures from pass 1 of the adversarial review of the client-response gate (brk-d2gate, 2026-10-02):
 * 65 are DETECTED (a hit of the class it violates); A9 is verbatim and a stated limit (any-typed). Plus negatives: the correct shape of the
 * same code must stay quiet, so a hardened rule cannot buy detection with false positives. The fail-closed
 * behaviour of the CLI is exercised in a throwaway git repo.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeSources } from '../../../scripts/ci/clientResponseRule';
import { FIXTURES, STATED_LIMITS } from './clientResponseFixtures';

const wrap = (b: string) => `import { apiFetch, assertOk, apiErrorMessage, apiJson } from '@/lib/apiFetch';\nexport async function f() {\n${b}\n}\n`;
const kinds = (src: string) => analyzeSources([{ file: 'pages/n.tsx', text: src }]).hits.map((h) => h.kind);

describe('evasion fixtures (pass 1): detected, or a stated limit that is asserted to still be missed', () => {
  const batch = analyzeSources(FIXTURES.map(([, , src], i) => ({ file: `pages/f${i}.tsx`, text: src })));
  FIXTURES.forEach(([kind, name], i) => {
    const seen = () => batch.hits.some((h) => h.file === `pages/f${i}.tsx` && h.kind === kind);
    if (STATED_LIMITS.has(name)) it(`${name} -> stated limit, still missed`, () => expect(seen()).toBe(false));
    else it(`${name} -> class ${kind}`, () => expect(seen()).toBe(true));
  });
});

describe('negatives: the correct shape stays quiet', () => {
  const W = `{ method: 'POST', body: '{}' }`;
  const quiet: Array<[string, string]> = [
    ['assertOk then read', wrap(`const res = await apiFetch('/x'); await assertOk(res, 'Could not load x - try again'); return res.json();`)],
    ['if (!res.ok) throw, then read', wrap(`const res = await apiFetch('/x'); if (!res.ok) throw new Error('Could not load x - try again'); return res.json();`)],
    ['read inside if (res.ok) with an else', wrap(`const res = await apiFetch('/x'); if (res.ok) { return res.json(); } else { setError('Could not load x - try again'); }`)],
    ['ternary read', wrap(`const res = await apiFetch('/x'); return res.ok ? await res.json() : null;`)],
    ['&& read', wrap(`const res = await apiFetch('/x'); return res.ok && (await res.json());`)],
    ['.then with assertOk', wrap(`return apiFetch('/x').then(async (r) => { await assertOk(r, 'Could not load x - try again'); return r.json(); });`)],
    ['same name in two branches, each checked', wrap(`if (x) { const res = await apiFetch('/a'); await assertOk(res, 'Could not load a - try again'); setA(await res.json()); } else { const res = await apiFetch('/b'); if (!res.ok) throw new Error('Could not load b - try again'); setB(await res.json()); }`)],
    ['alias checked through the original', wrap(`const res = await apiFetch('/x'); const r2 = res; await assertOk(res, 'Could not load x - try again'); return r2.json();`)],
    ['apiJson', wrap(`const data = await apiJson('/x', undefined, 'Could not load x - try again'); return data;`)],
    ['catch via apiErrorMessage and a log call', wrap(`try { await apiFetch('/x'); } catch (err) { log.error('x', { m: err.message }); setError(apiErrorMessage(err, 'Could not load x - try again')); }`)],
    ['narrowed ApiRequestError message', `import { ApiRequestError } from '@/lib/apiFetch';\nexport function g(e: unknown) { if (e instanceof ApiRequestError) setError(e.message); }`],
    ['awaited write checked', wrap(`const res = await apiFetch('/x', ${W}); await assertOk(res, 'Could not save - try again');`)],
    ['write checked in a then', wrap(`apiFetch('/x', ${W}).then((r) => assertOk(r, 'Could not save - try again')).catch((e) => setError(apiErrorMessage(e, 'Could not save - try again')));`)],
    ['Promise.all writes each checked', wrap(`const rs = await Promise.all([apiFetch('/a', ${W}), apiFetch('/b', ${W})]); rs.forEach((r) => { if (!r.ok) setError('Could not save - try again'); });`)],
    ['returned write whose caller checks it', wrap(`const save = () => apiFetch('/x', ${W}); const res = await save(); await assertOk(res, 'Could not save - try again');`)],
    ['GET with typed method', wrap(`const m: 'GET' = 'GET'; const res = await apiFetch('/x', { method: m }); await assertOk(res, 'Could not load x - try again');`)],
    ['a sentence, a typed state value, a comparison', wrap(`declare const setSt: (s: 'idle' | 'error') => void; setError('Could not save - try again'); setSt('error'); if (s === 'Failed') return;`)],
    ['status only in an if condition', wrap(`const res = await apiFetch('/x'); if (res.status === 409) { setError('That already exists'); return; } if (!res.ok) throw new Error('Could not save - try again'); return res.json();`)],
  ];
  for (const [name, src] of quiet) it(name, () => expect(kinds(src)).toEqual([]));
});

describe('fail-closed CLI', () => {
  const cli = resolve('scripts/ci/check-client-responses.ts');
  const run = (dir: string) => { try { execFileSync('bun', [cli], { cwd: dir, stdio: 'pipe', encoding: 'utf8' }); return 0; } catch (e) { return (e as { status: number }).status; } };
  const repo = (files: Record<string, string>, pins = '[]') => {
    const dir = mkdtempSync(join(tmpdir(), 'crg-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    mkdirSync(join(dir, 'scripts/ci'), { recursive: true });
    writeFileSync(join(dir, 'scripts/ci/client-responses.pins.json'), pins);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['dom', 'esnext'], jsx: 'preserve', strict: true } }));
    for (const [f, t] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), t); }
    return dir;
  };
  it('an empty file list fails', () => { const d = repo({}); expect(run(d)).toBe(1); rmSync(d, { recursive: true }); });
  it('a clean page passes, and the same page with one violation fails', () => {
    const clean = `export async function f() { const res = await fetch('/api/x'); if (!res.ok) throw new Error('Could not load x - try again'); return res.json(); }\n`;
    const d = repo({ 'pages/p.tsx': clean }); expect(run(d)).toBe(0);
    writeFileSync(join(d, 'pages/p.tsx'), clean.replace("if (!res.ok) throw new Error('Could not load x - try again'); ", ''));
    expect(run(d)).toBe(1); rmSync(d, { recursive: true });
  });
  it('plain JavaScript pages are scanned too', () => {
    const d = repo({ 'pages/p.jsx': `export async function f() { const res = await fetch('/api/x'); return res.json(); }\n` });
    expect(run(d)).toBe(1); rmSync(d, { recursive: true });
  });
  it('a pin without a real reason, and a stale pin, both fail', () => {
    const clean = `export const x = 1;\nexport async function f() { return fetch('/api/x').then((r) => (r.ok ? 1 : 0)); }\n`;
    let d = repo({ 'pages/p.tsx': clean }, JSON.stringify([{ file: 'pages/p.tsx', kind: 'a', line: 'nothing', reason: 'xxxxxxxxxxxx' }]));
    expect(run(d)).toBe(1); rmSync(d, { recursive: true });
    d = repo({ 'pages/p.tsx': clean }, JSON.stringify([{ file: 'pages/p.tsx', kind: 'a', line: 'nothing', reason: 'a stale pin that matches no line any more' }]));
    expect(run(d)).toBe(1); rmSync(d, { recursive: true });
  });
  it('a pin covers only the number of hits it declares', () => {
    const line = "const a = await fetch('/api/x', { method: 'POST' });";
    const one = JSON.stringify([{ file: 'pages/p.tsx', kind: 'd', line, reason: 'telemetry, nothing the person sees changes' }]);
    let d: string;
    const dup = `export async function f() {\n  const a = await fetch('/api/x', { method: 'POST' });\n  const a = await fetch('/api/x', { method: 'POST' });\n}\n`;
    d = repo({ 'pages/p.tsx': dup }, one); expect(run(d)).toBe(1); rmSync(d, { recursive: true });
  });
});
