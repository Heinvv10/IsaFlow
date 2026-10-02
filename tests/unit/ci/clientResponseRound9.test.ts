/**
 * Round 9 additions to the client-response gate: the fallback argument is user-visible text, a busy flag
 * released before a navigation completes, import aliases, and which files count as client code.
 */
import { describe, expect, it } from 'vitest';
import { analyzeFile, type HitKind } from '../../../scripts/ci/clientResponseRule';
import { selectClientFiles } from '../../../scripts/ci/clientResponseSelect';

const kinds = (src: string): HitKind[] => analyzeFile('pages/x.tsx', src).map((h) => h.kind).sort();
const wrap = (body: string) => `import { apiFetch, assertOk, apiErrorMessage, apiJson } from '@/lib/apiFetch';\nexport async function f() {\n${body}\n}\n`;

describe('(b) the assertOk / apiJson / apiErrorMessage fallback is the text a 502 or an empty 500 shows', () => {
  const bad = ['Failed to load', 'Save failed', 'Failed', 'Something went wrong - try again', 'Could not complete: sars efiling - try again', 'Action failed', 'Network error', 'An unexpected error occurred'];
  for (const text of bad) {
    it(`assertOk(res, ${JSON.stringify(text)}) is flagged`, () => expect(kinds(wrap(`const res = await apiFetch('/x'); await assertOk(res, ${JSON.stringify(text)});`))).toEqual(['b']));
  }
  it('apiJson (3rd argument) and apiErrorMessage (2nd) are judged the same way', () => {
    expect(kinds(wrap(`await apiJson('/x', undefined, 'Something went wrong');`))).toEqual(['b']);
    expect(kinds(wrap(`try { await apiJson('/x', undefined, 'Could not load x - try again'); } catch (e) { setError(apiErrorMessage(e, 'Save failed')); }`))).toEqual(['b']);
  });
  it('a sentence that says what could not be done is quiet', () => {
    expect(kinds(wrap(`const res = await apiFetch('/x'); await assertOk(res, 'Could not submit the VAT201 to SARS - try again');`))).toEqual([]);
    expect(kinds(wrap(`try { await apiJson('/x', undefined, 'Could not load the rows - try again'); } catch (e) { setError(apiErrorMessage(e, 'Could not load the rows - try again')); }`))).toEqual([]);
  });
  it('a bare phrase with only filler after it is bare ("Something went wrong - try again", "Failed.")', () => {
    expect(kinds(wrap(`setError('Something went wrong - try again');`))).toEqual(['b']);
    expect(kinds(wrap(`setError('Failed.');`))).toEqual(['b']);
    expect(kinds(wrap(`toast.error('Network error');`))).toEqual(['b']);
  });
  it('a bare message passed as a JSX attribute is flagged, a value attribute is not', () => {
    expect(kinds(`export const C = () => <Banner message="Something went wrong" />;`)).toEqual(['b']);
    expect(kinds(`export const C = () => <option value="error">Failed</option>;`)).toEqual([]);
  });
  it('a status label in a ?: that compares to the same word is not a message', () => {
    expect(kinds(`export const C = ({ r }: { r: { status: string } }) => <td>{r.status === 'failed' ? 'Failed' : 'Sent'}</td>;`)).toEqual([]);
  });
});

describe('(e) a busy flag released before a navigation completes', () => {
  const page = (body: string) => `export function P({ router }: { router: { push(p: string): Promise<boolean> } }) {\n  const [, setBusy] = useState(false);\n  const go = async () => {\n    setBusy(true);\n    try {\n${body}\n  };\n}\n`;
  it('finally { setBusy(false) } after a bare router.push is flagged (double submit while the page leaves)', () => {
    expect(kinds(page(`      void router.push('/x');\n    } finally { setBusy(false); }`))).toEqual(['e']);
  });
  it('awaiting the navigation, or keeping the flag set on the success path, is quiet', () => {
    expect(kinds(page(`      await router.push('/x');\n    } finally { setBusy(false); }`))).toEqual([]);
    expect(kinds(page(`      navigating = true; window.location.href = '/x';\n    } finally { if (!navigating) setBusy(false); }`))).toEqual([]);
    expect(kinds(page(`      window.location.href = '/x';\n    } catch (e) { setBusy(false); }`))).toEqual([]);
  });
  it('a flag with no way to clear it is still flagged', () => {
    expect(kinds(page(`      await doIt();\n    } catch (e) { log(e); }`))).toEqual(['e']);
  });
});

describe('import alias of an apiFetch helper', () => {
  it('apiFetch as request: a write nobody checks, and a body read before the status, are still seen', () => {
    const src = `import { apiFetch as request, assertOk as ok } from '@/lib/apiFetch';\nexport async function f() { await request('/x', { method: 'POST', body: '{}' }); const r = await request('/y'); return r.json(); }\n`;
    expect(kinds(src)).toEqual(['a', 'd']);
    expect(kinds(`import { apiFetch as request, assertOk as ok } from '@/lib/apiFetch';\nexport async function f() { const r = await request('/y'); await ok(r, 'Could not load y - try again'); return r.json(); }\n`)).toEqual([]);
  });
});

describe('getServerSideProps is server code inside a client page', () => {
  it('a fetch there is not reported; the client code of the same page is', () => {
    const src = `import { apiFetch } from '@/lib/apiFetch';\nexport async function getServerSideProps() { const r = await apiFetch('/x'); return { props: await r.json() }; }\nexport default function P() { return null; }\nexport async function load() { const r = await apiFetch('/y'); return r.json(); }\n`;
    const hits = analyzeFile('pages/x.tsx', src);
    expect(hits.map((h) => h.line)).toEqual([4]);
  });
});

describe('which files are client code', () => {
  const read = (m: Record<string, string>) => (f: string) => m[f]!;
  const sel = (m: Record<string, string>) => selectClientFiles(Object.keys(m), read(m));
  it('a page with getServerSideProps is still scanned; a comment mentioning server-only does not drop it', () => {
    const m = { 'pages/a.tsx': `import { getServerSideProps as g } from 'x';\nexport const getServerSideProps = async () => ({ props: {} });\nexport default function A() { fetch('/x').then((r) => r.json()); return null; }\n`, 'pages/b.tsx': `// never imported from server-only modules\nexport default function B() { return null; }\n` };
    expect(sel(m)).toEqual(['pages/a.tsx', 'pages/b.tsx']);
  });
  it('a file importing a server module is not client code; a comment naming apiFetch does not select a helper', () => {
    const m = { 'src/modules/x/svc.ts': `import { sql } from '@/lib/neon';\nexport const q = () => sql\`select 1\`;\n`, 'src/lib/note.ts': `// callers use apiFetch\nexport const n = 1;\n` };
    expect(sel(m)).toEqual([]);
  });
  it('a helper in src/lib is scanned when a client imports it and it touches the network or a Response', () => {
    const m = {
      'pages/p.tsx': `import { readJson } from '@/lib/http';\nimport { fetcher } from '@/lib/swr';\nimport { sign } from '@/lib/serverOnly';\nexport default function P() { return null; }\n`,
      'src/lib/http.ts': `export async function readJson(res: Response) { return res.json(); }\n`,
      'src/lib/swr.ts': `export const fetcher = (u: string) => fetch(u).then((r) => r.json());\n`,
      'src/lib/serverOnly.ts': `export const sign = async () => fetch(process.env.GOTRUE_URL as string);\n`,
      'src/lib/unrelated.ts': `export const x = fetch('/z');\n`,
    };
    expect(sel(m)).toEqual(['pages/p.tsx', 'src/lib/http.ts', 'src/lib/swr.ts']);
  });
});

describe('(g) a refused response shows a fixed sentence and drops the server message', () => {
  it('if (!res.ok) notify.error(literal) is flagged; assertOk + apiErrorMessage is not', () => {
    expect(kinds(wrap(`const res = await apiFetch('/x', { method: 'PATCH' }); if (!res.ok) notify.error('Could not update the currency - try again');`))).toEqual(['g']);
    expect(kinds(wrap(`const res = await apiFetch('/x', { method: 'PATCH' }); if (!res.ok) { setError('Could not update the currency - try again'); return; }`))).toEqual(['g']);
    expect(kinds(wrap(`try { const res = await apiFetch('/x', { method: 'PATCH' }); await assertOk(res, 'Could not update the currency - try again'); } catch (e) { notify.error(apiErrorMessage(e, 'Could not update the currency - try again')); }`))).toEqual([]);
    expect(kinds(wrap(`const res = await apiFetch('/x', { method: 'PATCH' }); if (!res.ok) { const j = await res.json(); notify.error(j.error.message); return; }`))).toEqual([]);
  });
});
