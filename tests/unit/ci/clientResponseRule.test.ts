/**
 * Mutation counterexamples for clientResponseRule: it must fire on each class of
 * defect (a-d) and stay quiet on the correct shape of the same code. The repo
 * itself is checked by scripts/ci/check-client-responses.ts (a `bun run ci` step).
 */
import { describe, expect, it } from 'vitest';
import { analyzeFile, type HitKind } from '../../../scripts/ci/clientResponseRule';

const kinds = (src: string): HitKind[] => analyzeFile('pages/x.tsx', src).map((h) => h.kind).sort();
const wrap = (body: string) => `import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';\nexport async function f() {\n${body}\n}\n`;

describe('(a) body read before a status check', () => {
  it('fires on json() with the status checked afterwards', () => {
    expect(kinds(wrap(`const res = await apiFetch('/x'); const json = await res.json(); if (!res.ok) throw new Error('Could not load x - try again');`))).toEqual(['a']);
  });
  it('fires on a body read off the fetch result and on .then(r => r.json())', () => {
    expect(kinds(wrap(`const j = await (await apiFetch('/x')).json(); return j;`))).toEqual(['a']);
    expect(kinds(wrap(`return apiFetch('/x').then(r => r.json());`))).toEqual(['a']);
  });
  it('fires on a Promise.all member read unchecked', () => {
    expect(kinds(wrap(`const [a, b] = await Promise.all([apiFetch('/a'), apiFetch('/b')]); await assertOk(a, 'x - try again'); return [await a.json(), await b.json()];`))).toEqual(['a']);
  });
  it('is quiet when assertOk, .ok or .status come first', () => {
    expect(kinds(wrap(`const res = await apiFetch('/x'); await assertOk(res, 'Could not load x - try again'); return res.json();`))).toEqual([]);
    expect(kinds(wrap(`const res = await apiFetch('/x'); if (!res.ok) return null; return res.json();`))).toEqual([]);
    expect(kinds(wrap(`return apiFetch('/x').then(async r => { await assertOk(r, 'Could not load x - try again'); return r.json(); });`))).toEqual([]);
  });
});

describe('(b) bare fallbacks', () => {
  it('fires on a bare Failed / Error message and on HTTP ${status}', () => {
    expect(kinds(wrap(`setError(e ? 'x' : 'Failed');`))).toEqual(['b']);
    expect(kinds(wrap(`await assertOk(res, 'Failed');`))).toEqual(['b']);
    expect(kinds(wrap('throw new Error(`HTTP ${res.status}`);'))).toEqual(['b']);
  });
  it('is quiet on a sentence, a state value and a comparison', () => {
    expect(kinds(wrap(`setError('Could not save the rate - try again'); setState('error'); if (s === 'Error') return;`))).toEqual([]);
  });
});

describe('(c) raw error text from a catch', () => {
  it('fires on err.message and String(err) rendered from a catch', () => {
    expect(kinds(wrap(`try { await apiFetch('/x'); } catch (err) { setError(err instanceof Error ? err.message : 'Could not save - try again'); }`))).toEqual(['c']);
    expect(kinds(wrap(`try { await apiFetch('/x'); } catch (err) { notify.error(String(err)); }`))).toEqual(['c']);
    expect(kinds(wrap(`apiFetch('/x').catch((e) => setError(e.message));`))).toEqual(['c']);
  });
  it('is quiet through apiErrorMessage and in log calls', () => {
    expect(kinds(wrap(`try { await apiFetch('/x'); } catch (err) { setError(apiErrorMessage(err, 'Could not save - try again')); log.error('save', { m: err.message }); }`))).toEqual([]);
  });
});

describe('(d) a write whose result is never checked', () => {
  const W = `{ method: 'POST', body: '{}' }`;
  it('fires on a bare write, a void write and a .catch-only chain', () => {
    expect(kinds(wrap(`await apiFetch('/x', ${W});`))).toEqual(['d']);
    expect(kinds(wrap(`void apiFetch('/x', ${W});`))).toEqual(['d']);
    expect(kinds(wrap(`apiFetch('/x', ${W}).catch(() => undefined);`))).toEqual(['d']);
    expect(kinds(wrap(`const res = await apiFetch('/x', ${W}); await reload();`))).toEqual(['d']);
  });
  it('is quiet when the response is checked, however it is bound', () => {
    expect(kinds(wrap(`const res = await apiFetch('/x', ${W}); await assertOk(res, 'Could not save - try again');`))).toEqual([]);
    expect(kinds(wrap(`const res = ok ? await apiFetch('/x', ${W}) : await apiFetch('/y', ${W}); await assertOk(res, 'Could not save - try again');`))).toEqual([]);
    expect(kinds(wrap(`apiFetch('/x', ${W}).then(r => assertOk(r, 'Could not save - try again')).catch(() => undefined);`))).toEqual([]);
    expect(kinds(wrap(`await assertOk(await apiFetch('/x', ${W}), 'Could not save - try again');`))).toEqual([]);
  });
  it('ignores reads', () => {
    expect(kinds(wrap(`await apiFetch('/x', { method: 'GET' });`))).toEqual([]);
  });
});
