/**
 * brk-d2gate evasion fixtures for scripts/ci/clientResponseRule.ts, run at sha 142786a85.
 *
 * Each entry: [class the snippet violates, name, source]. `analyzeFile('pages/x.tsx', src)` should
 * return at least one hit of that class. At 142786a85, 63 of 66 return none (the three that are
 * caught are marked CAUGHT below and are kept as controls).
 *
 * Use as RED tests, e.g. from tests/unit/ci/:
 *   import { analyzeFile } from '../../../scripts/ci/clientResponseRule';
 *   for (const [k, name, src] of FIXTURES) it(name, () => expect(analyzeFile('pages/x.tsx', src).some((h) => h.kind === k)).toBe(true));
 *
 * A4, A5, A7, D2, D3 fall under the limits the rule header states (helper declared elsewhere,
 * method in a variable, check on a different code path); they are included because a developer
 * writes them naturally, not because the header hides them.
 */
export type FixtureKind = 'a' | 'b' | 'c' | 'd';

const wrap = (b: string) => `import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';\nexport async function f() {\n${b}\n}\n`;
const W = `{ method: 'POST', body: '{}' }`;

export const FIXTURES: Array<[FixtureKind, string, string]> = [
  // ── (a) body read with no (real) status check ──────────────────────────────
  ['a', 'A1 let + assignment', wrap(`let res; res = await apiFetch('/x'); return res.json();`)],
  ['a', 'A2 fetch().catch(()=>null) bound', wrap(`const res = await apiFetch('/x').catch(() => null); return res?.json();`)],
  ['a', 'A3 ternary-bound', wrap(`const res = c ? await apiFetch('/a') : await apiFetch('/b'); return res.json();`)],
  ['a', 'A4 helper reads it', wrap(`const read = (r: Response) => r.json(); const res = await apiFetch('/x'); return read(res);`)],
  ['a', 'A5 .then(parse) named helper', wrap(`const parse = (r: Response) => r.json(); return apiFetch('/x').then(parse);`)],
  ['a', 'A6 status only logged', wrap(`const res = await apiFetch('/x'); log.info('got', res.status); return res.json();`)],
  ['a', 'A7 check in a different branch', wrap(`const res = await apiFetch('/x'); if (debug) { if (!res.ok) return null; } return res.json();`)],
  ['a', 'A8 same name, second binding later in fn', wrap(`if (x) { const res = await apiFetch('/a'); setA(await res.json()); } else { const res = await apiFetch('/b'); await assertOk(res, 'Could not load b - try again'); setB(await res.json()); }`)],
  ['a', 'A9 Promise.all(map) then map json', wrap(`const urls: string[] = []; const rs = await Promise.all(urls.map((u) => apiFetch(u))); return Promise.all(rs.map((r) => r.json()));`)],
  ['a', 'A10 Promise.all().then(([a,b])=>)', wrap(`return Promise.all([apiFetch('/a'), apiFetch('/b')]).then(([a, b]) => Promise.all([a.json(), b.json()]));`)],
  ['a', 'A11 destructured read', wrap(`const { json } = await apiFetch('/x'); return json();`)],
  ['a', 'A12 clone().json()', wrap(`const res = await apiFetch('/x'); return res.clone().json();`)],
  ['a', 'A13 promise var then awaited', wrap(`const p = apiFetch('/x'); const res = await p; return res.json();`)],
  ['a', 'A14 local wrapper fn', wrap(`const get = (u: string) => apiFetch(u); const res = await get('/x'); return res.json();`)],
  ['a', 'A15 for-of over responses', wrap(`for (const res of await Promise.all([apiFetch('/a')])) { out.push(await res.json()); }`)],
  ['a', 'A16 globalThis.fetch', wrap(`const res = await globalThis.fetch('/x'); return res.json();`)],
  ['a', 'A17 then with differently-shaped param (CAUGHT at 142786a85)', wrap(`return apiFetch('/x').then((r: Response) => r).then((x) => x.json());`)],
  ['a', 'A18 assertOk not awaited', wrap(`const res = await apiFetch('/x'); void assertOk(res, 'Could not load x - try again'); return res.json();`)],

  // ── (b) bare fallback / status code reaching a person ──────────────────────
  ['b', 'B1 JSX fallback', `export const C = ({ error }: { error?: string }) => <p>{error || 'Failed'}</p>;`],
  ['b', 'B2 variable then sink', wrap(`const msg = json.error || 'Failed'; setError(msg);`)],
  ['b', 'B3 setSaveError', wrap(`setSaveError('Failed');`)],
  ['b', 'B4 setErr', wrap(`setErr('Error');`)],
  ['b', 'B5 onError prop callback', wrap(`onError('Failed');`)],
  ['b', 'B6 HTTP concat', wrap(`throw new Error('HTTP ' + res.status);`)],
  ['b', 'B7 status in template without HTTP', wrap('setError(`Error ${res.status}`);')],
  ['b', 'B8 JSX text', `export const C = () => <p className="text-red-500">Failed</p>;`],
  ['b', 'B9 Failed!!', wrap(`setError('Failed!!');`)],
  ['b', 'B10 template wrapper', wrap('setError(`${"Failed"}`); toast.error(`Failed: ${x}`);')],
  ['b', 'B11 dispatch payload', wrap(`dispatch({ type: 'fail', payload: 'Failed' });`)],
  ['b', 'B12 return string shown by caller', wrap(`return 'Failed';`)],
  ['b', 'B13 enqueueSnackbar', wrap(`enqueueSnackbar('Error', { variant: 'error' });`)],
  ['b', 'B14 setState updater', wrap(`setError(() => 'Failed');`)],
  ['b', 'B15 Request failed / Something went wrong', wrap(`setError('Request failed'); toast.error('Something went wrong');`)],

  // ── (c) raw error text from a fetch catch ──────────────────────────────────
  ['c', 'C1 (err as Error).message', wrap(`try { await apiFetch('/x'); } catch (err) { setError((err as Error).message); }`)],
  ['c', 'C2 err.toString()', wrap(`try { await apiFetch('/x'); } catch (err) { setError(err.toString()); }`)],
  ['c', 'C3 concat', wrap(`try { await apiFetch('/x'); } catch (err) { setError('Failed: ' + err); }`)],
  ['c', 'C4 alias then .message', wrap(`try { await apiFetch('/x'); } catch (err) { const e = err as Error; setError(e.message); }`)],
  ['c', 'C5 destructured catch', wrap(`try { await apiFetch('/x'); } catch ({ message }) { setError(message); }`)],
  ['c', 'C6 .catch(named handler)', wrap(`const onErr = (e: Error) => setError(e.message); apiFetch('/x').catch(onErr);`)],
  ['c', 'C7 .then(ok, err => ...)', wrap(`apiFetch('/x').then(() => 1, (e) => setError(e.message));`)],
  ['c', 'C8 raw object into state', wrap(`try { await apiFetch('/x'); } catch (err) { setError(err); }`)],
  // NOT wrapped: the file must not contain the text apiFetch / apiJson / assertOk / fetch( — that is the point.
  ['c', 'C9 file calls an imported helper (no apiFetch text)', `import { loadRows } from './rows';\nexport async function f() { try { await loadRows(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not load rows - try again'); } }`],
  ['c', 'C10 JSON.stringify(err)', wrap(`try { await apiFetch('/x'); } catch (err) { setError(JSON.stringify(err)); }`)],
  ['c', 'C11 element access', wrap(`try { await apiFetch('/x'); } catch (err) { setError(err['message']); }`)],
  ['c', 'C12 onError callback', wrap(`useMutation({ mutationFn: () => apiFetch('/x'), onError: (e: Error) => toast.error(e.message) });`)],

  // ── (d) mutating call whose result is never checked ────────────────────────
  ['d', 'D1 method ternary', wrap(`await apiFetch('/x', { method: editing ? 'PUT' : 'POST', body: '{}' });`)],
  ['d', 'D2 method variable', wrap(`const method = 'DELETE'; await apiFetch('/x', { method });`)],
  ['d', 'D3 opts variable', wrap(`const opts = { method: 'POST', body: '{}' }; await apiFetch('/x', opts);`)],
  ['d', 'D4 spread opts', wrap(`await apiFetch('/x', { ...base, body: '{}' });`)],
  ['d', 'D5 quoted key', wrap(`await apiFetch('/x', { 'method': 'POST', body: '{}' });`)],
  ['d', 'D6 assignment, never checked', wrap(`let res; res = await apiFetch('/x', ${W}); await reload();`)],
  ['d', 'D7 returned to a caller that ignores it', wrap(`const save = () => { return apiFetch('/x', ${W}); }; await save(); await reload();`)],
  ['d', 'D8 arrow body', wrap(`const del = (id: string) => apiFetch('/x/' + id, { method: 'DELETE' }); await del('1');`)],
  ['d', 'D9 .status in body satisfies chain regex', wrap(`apiFetch('/x', { method: 'POST', body: JSON.stringify({ status: form.status }) }).then(() => reload());`)],
  ['d', 'D10 Promise.all writes, unrelated .status in fn', wrap(`await Promise.all([apiFetch('/a', ${W}), apiFetch('/b', ${W})]); if (row.status === 'x') reload();`)],
  ['d', 'D11 status only logged', wrap(`const res = await apiFetch('/x', ${W}); log.info('saved', res.status); await reload();`)],
  ['d', 'D12 Promise.all(map) writes', wrap(`await Promise.all(ids.map((id) => apiFetch('/x/' + id, { method: 'DELETE' })));`)],
  ['d', 'D13 sendBeacon', wrap(`navigator.sendBeacon('/api/x', '{}');`)],
  ['d', 'D14 XMLHttpRequest', wrap(`const x = new XMLHttpRequest(); x.open('POST', '/api/x'); x.send('{}');`)],
  ['d', 'D15 axios', wrap(`await axios.post('/api/x', {});`)],
  ['d', 'D16 template-literal method', wrap('await apiFetch("/x", { method: `${"POST"}`, body: "{}" });')],
  ['d', 'D17 checked var is a different response (CAUGHT at 142786a85)', wrap(`const res = await apiFetch('/x', ${W}); const res2 = await apiFetch('/y'); if (!res2.ok) return; await reload();`)],
  ['d', 'D18 inside ternary statement (CAUGHT at 142786a85)', wrap(`ok ? await apiFetch('/x', ${W}) : null;`)],
  ['d', 'D19 new Request', wrap(`await fetch(new Request('/x', ${W}));`)],
  ['d', 'D20 logical &&', wrap(`ready && (await apiFetch('/x', ${W}));`)],
  ['d', 'D21 apiJson().catch swallow', wrap(`apiJson('/x', ${W}).catch(() => undefined);`)],
];
