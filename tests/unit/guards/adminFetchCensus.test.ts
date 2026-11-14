/**
 * Admin UI census: every client call to /api/admin goes through `adminFetch`.
 *
 * SOURCE RATCHET over every tracked CLIENT file (the client-response gate's own selection), not a fixed folder list.
 * `withAdmin` 403s any non-GET without `X-Admin-Request`; a page that forgets it shows a dead button. The scanner is
 * AST based (tests/helpers/adminFetchCensus.ts); the fixtures below are the shapes that evaded the first, regex
 * version, and each must be caught.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { adminFetchViolations } from '../../helpers/adminFetchCensus';
import { selectClientFiles } from '../../../scripts/ci/clientResponseSelect';

const IMP = `import { adminFetch } from '@/lib/admin/adminFetch';\nimport { apiFetch, apiJson } from '@/lib/apiFetch';\n`;
const wrap = (body: string, imports = IMP) => `${imports}export async function f() {\n${body}\n}\n`;

const EVASIONS: Array<[string, string]> = [
  ['concatenated route', `await apiFetch('/api/' + 'admin/x', { method: 'POST' });`],
  ['template whose static part is only /api/', 'const seg = \'admin\'; await apiFetch(`/api/${seg}/x`, { method: \'POST\' });'],
  ['segment before /admin', 'await apiFetch(`${base}/admin/x`, { method: \'POST\' });'],
  ["window['fetch']", `await window['fetch']('/api/admin/x', { method: 'POST' });`],
  ["globalThis['fetch']", `await globalThis['fetch']('/api/admin/x', { method: 'POST' });`],
  ['route constant imported from an unselected module', `await apiFetch(ADMIN_ROUTES.x, { method: 'POST' });`],
  ['const URL variable', `const U = '/api/admin/x'; await apiFetch(U, { method: 'POST' });`],
  ['endpoint variable', 'const endpoint = `/api/admin/x`; await apiFetch(endpoint);'],
  ['window.fetch', `await window.fetch('/api/admin/x', { method: 'POST' });`],
  ['globalThis.fetch', `await globalThis.fetch('/api/admin/x', { method: 'POST' });`],
  ['bare fetch', `await fetch('/api/admin/x', { method: 'POST' });`],
  ['apiFetch<T>', `await apiFetch<Foo>('/api/admin/x', { method: 'POST' });`],
  ['apiFetch (space)', `await apiFetch ('/api/admin/x', { method: 'POST' });`],
  ['BASE +', `const BASE = '/api/admin'; await apiFetch(BASE + '/x', { method: 'POST' });`],
  ['template with BASE', 'const BASE = \'/api/admin\'; await apiFetch(`${BASE}/x`, { method: \'POST\' });'],
  ['ADMIN_API constant', `await apiFetch(ADMIN_API + '/x', { method: 'POST' });`],
  ['aliased callee', `await req('/api/admin/x', { method: 'POST' });`],
  ['apiJson with an options variable', `const opts = { method: 'POST' }; await apiJson('/api/admin/x', opts);`],
  ['apiJson with a spread', `await apiJson('/api/admin/x', { ...opts, method: 'POST' });`],
  ['header only in a comment', `await apiFetch('/api/admin/x', { method: 'POST' }); // X-Admin-Request: true`],
  ['header with another value', `await apiJson('/api/admin/x', { method: 'POST', headers: { 'X-Admin-Request': 'false' } });`],
  ['const f = apiFetch', `const f = apiFetch; await f('/api/admin/x', { method: 'POST' });`],
  ['apiFetch passed as a value', `await Promise.all([1].map(apiFetch)); const u = '/api/admin/x';`],
  ['hand-set header inside adminFetch', `await adminFetch('/api/admin/x', { method: 'POST', headers: { 'X-Admin-Request': 'true' } });`],
  ['admin string without importing adminFetch', `await apiFetch('/api/admin/x');`],
];

describe('adminFetchViolations: every evasion shape is caught', () => {
  it.each(EVASIONS)('%s', (name, body) => {
    const imports = name.startsWith('route constant imported') ? `import { ADMIN_ROUTES } from './routes';\n${IMP}`
      : name === 'aliased callee' ? `import { adminFetch } from '@/lib/admin/adminFetch';\nimport { apiFetch as req } from '@/lib/apiFetch';\n`
      : name === 'admin string without importing adminFetch' ? `import { apiFetch } from '@/lib/apiFetch';\n` : IMP;
    expect(adminFetchViolations(wrap(body, imports))).not.toEqual([]);
  });
});

describe('adminFetchViolations: legitimate shapes are quiet', () => {
  it.each([
    ['adminFetch, GET and write', `await adminFetch('/api/admin/x'); await adminFetch('/api/admin/y', { method: 'POST', headers: { 'Content-Type': 'application/json' } });`],
    ['a plain non-admin literal through apiFetch', `await adminFetch('/api/admin/x'); await apiFetch('/api/accounting/migration-parse', { method: 'POST' });`],
    ['apiJson on an admin route with the real header', `await adminFetch('/api/admin/x'); await apiJson('/api/admin/u/1/impersonate', { method: 'POST', headers: { 'X-Admin-Request': 'true' } });`],
    ['a link to the admin UI built from a template, and an imported non-ADMIN constant', "import { PACK_DATA_API } from './p';\nconst h = `${base}/admin/tools/x`;\nawait adminFetch('/api/admin/x');"],
    ['a header named only in a comment and a type', `// X-Admin-Request\ntype R = '/api/admin/x';\nawait adminFetch('/api/admin/x');`],
  ])('%s', (_n, body) => expect(adminFetchViolations(wrap(body))).toEqual([]));
  it('a file that never touches /api/admin is not an admin file', () => {
    expect(adminFetchViolations(wrap(`await apiFetch(url);`, "import { apiFetch } from '@/lib/apiFetch';\n"))).toEqual([]);
  });
});

describe('the tracked client files', () => {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 1 << 27 }).split('\n').filter((f) => /\.tsx?$/.test(f));
  const files = selectClientFiles(tracked, (f) => readFileSync(f, 'utf8'))
    .filter((f) => !/^(pages\/api\/|tests\/|scripts\/)/.test(f) && f !== 'src/lib/admin/adminFetch.ts' && f !== 'src/lib/apiFetch.ts');
  it('selects the admin UI (an empty census proves nothing)', () => {
    expect(files.filter((f) => f.startsWith('pages/admin/')).length).toBeGreaterThan(20);
  });
  it('no client file bypasses adminFetch or hand-sets its header', () => {
    const offenders = files.flatMap((f) => adminFetchViolations(readFileSync(f, 'utf8'), f).map((v) => `${f}:${v}`));
    expect(offenders).toEqual([]);
  });
});
