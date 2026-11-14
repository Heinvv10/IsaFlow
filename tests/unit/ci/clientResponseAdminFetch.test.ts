/**
 * `adminFetch` (src/lib/admin/adminFetch.ts) is `apiFetch` plus a header, so the client-response gate must hold its
 * callers to every rule it applies to `apiFetch` callers. It matched callees BY NAME, so switching ~100 admin call
 * sites to adminFetch silently dropped rules d/f for them. Each case runs the same source under both names.
 */
import { describe, expect, it } from 'vitest';
import { analyzeFile, type HitKind } from '../../../scripts/ci/clientResponseRule';

const kinds = (src: string): HitKind[] => analyzeFile('pages/x.tsx', src).map((h) => h.kind).sort();
const HEAD = (name: string, alias = name) =>
  `import { ${alias === name ? name : `${name} as ${alias}`} } from '${name === 'adminFetch' ? '@/lib/admin/adminFetch' : '@/lib/apiFetch'}';\nimport { assertOk, apiErrorMessage } from '@/lib/apiFetch';\n`;
const src = (name: string, body: string, alias = name) => `${HEAD(name, alias)}export async function f() {\n${body}\n}\n`;

describe.each(['apiFetch', 'adminFetch'])('%s callers are held to the same rules', (name) => {
  it('(d) a POST whose result is never checked is flagged', () => {
    expect(kinds(src(name, `await ${name}('/api/admin/x', { method: 'POST' });`))).toEqual(['d']);
  });
  it('(d) a checked POST is quiet', () => {
    expect(kinds(src(name, `const res = await ${name}('/api/admin/x', { method: 'POST' }); await assertOk(res, 'Could not save x - try again');`))).toEqual([]);
  });
  it('(d) a POST with the method in a variable counts as a write', () => {
    expect(kinds(src(name, `const method = 'POST'; await ${name}('/api/admin/x', { method });`))).toEqual(['d']);
  });
  it('(f) a failed load that sets an error but keeps the rows is flagged', () => {
    const body = `try { const res = await ${name}('/api/admin/x'); await assertOk(res, 'Could not load x - try again'); const json = await res.json(); setRows(json.data); } catch (e) { setError(apiErrorMessage(e, 'Could not load x - try again')); }`;
    expect(kinds(src(name, body))).toEqual(['f']);
  });
  it('(f) a save (a write) is not a load, so it keeps the rows', () => {
    const body = `try { const res = await ${name}('/api/admin/x', { method: 'PATCH' }); await assertOk(res, 'Could not save x - try again'); const json = await res.json(); setRow(json.data); } catch (e) { setError(apiErrorMessage(e, 'Could not save x - try again')); }`;
    expect(kinds(src(name, body))).toEqual([]);
  });
});

it('an import alias of adminFetch is undone, so its writes are still checked', () => {
  expect(kinds(src('adminFetch', `await request('/api/admin/x', { method: 'POST' });`, 'request'))).toEqual(['d']);
});
