/**
 * Pass 2 of the adversarial review (brk-d2gate2, 2026-10-02): 55 natural evasions + 16 correct shapes, VERBATIM
 * (they were written as real files; here they run in memory through selectClientFiles + analyzeSources).
 * A fixture the gate does not detect is marked `expectedLimit` with the group that explains it (LIMIT_GROUPS):
 * the test then asserts it is STILL missed, so a future improvement flips it deliberately (move it out of the group).
 *
 * Original header:
 * brk-d2gate2 evasion fixtures for the client-response gate, run at sha 8897737d5.
 *
 * Each fixture is one or more REAL files (paths relative to the repo root). The runner writes them into a throwaway
 * worktree at 8897737d5 and runs the real CLI (bun scripts/ci/check-client-responses.ts), so file SELECTION is part
 * of the test: a fixture is DETECTED when the CLI reports a hit of `kind` in one of the fixture's files.
 * Imports resolve against the real repo (@/lib/apiFetch, react, react-hot-toast), so types are the real ones.
 *
 * `stated: true` marks a shape the rule header lists as a STATED LIMIT. Everything else is unstated.
 *
 * NEGATIVES are correct code: each must produce NO hit.
 */
export type Kind = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
export interface Fx { id: string; kind: Kind; name: string; files: Record<string, string>; stated?: boolean }

const H = `import { useCallback, useEffect, useReducer, useState, Component } from 'react';
import toast from 'react-hot-toast';
import { apiFetch, apiJson, assertOk, apiErrorMessage } from '@/lib/apiFetch';
declare const setRows: (r: unknown) => void; declare const setError: (e: string | null) => void; declare const reload: () => Promise<void>;
`;
const page = (id: string, body: string) => ({ [`pages/zzbrk2/${id}.tsx`]: H + body });
const W = `{ method: 'POST', body: JSON.stringify({ name: 'x' }) }`;

const RAW_FIXTURES: Fx[] = [
  // ── (a) body read with no real status check ───────────────────────────────
  { id: 'a01', kind: 'a', name: 'only a 404 special case, then the body is parsed (500 html -> SyntaxError)',
    files: page('a01', `export async function loadInvoice(id: string) {
  const res = await apiFetch(\`/api/accounting/invoices/\${id}\`);
  if (res.status === 404) return null;
  return res.json();
}`) },
  { id: 'a02', kind: 'a', name: 'status copied to a const, body read, status judged after',
    files: page('a02', `export async function load() {
  const res = await apiFetch('/api/accounting/invoices');
  const status = res.status;
  const body = await res.json();
  if (status >= 400) throw new Error(body.error ?? 'Could not load the invoices - try again');
  return body;
}`) },
  { id: 'a03', kind: 'a', name: 'ids come from a body (any), so the fan-out responses are any',
    files: page('a03', `export async function loadAll() {
  const listRes = await apiFetch('/api/accounting/invoices');
  await assertOk(listRes, 'Could not load the invoices - try again');
  const { ids } = await listRes.json();
  const rs = await Promise.all(ids.map((id: string) => apiFetch(\`/api/accounting/invoices/\${id}\`)));
  return Promise.all(rs.map((r) => r.json()));
}`) },
  { id: 'a04', kind: 'a', name: '.then ternary on a 204 only: every other status is parsed',
    files: page('a04', `export function loadLines(id: string) {
  return apiFetch(\`/api/accounting/journals/\${id}/lines\`).then((r) => (r.status === 204 ? [] : r.json()));
}`) },
  { id: 'a05', kind: 'a', name: 'shared helper in src/lib reads the body unchecked; its file is never selected',
    files: {
      'src/lib/zzbrk2_a05_http.ts': `export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
`,
      ...page('a05', `import { readJson } from '@/lib/zzbrk2_a05_http';
export async function load() { const res = await apiFetch('/api/accounting/rows'); return readJson<unknown[]>(res); }`),
    } },
  { id: 'a06', kind: 'a', name: 'hook in src/hooks returns a getter; caller reads the response it returns',
    files: {
      'src/hooks/zzbrk2_a06_useGet.ts': `import { useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
export function useGet() { return useCallback((url: string) => apiFetch(url), []); }
`,
      ...page('a06', `import { useGet } from '@/hooks/zzbrk2_a06_useGet';
export function Rows() { const get = useGet(); useEffect(() => { void (async () => { const res = await get('/api/accounting/rows'); setRows(await res.json()); })(); }, [get]); return null; }`),
    } },
  { id: 'a07', kind: 'a', name: 'SWR/react-query style fetcher in src/lib with raw fetch: file never selected',
    files: {
      'src/lib/zzbrk2_a07_fetcher.ts': `export const fetcher = (url: string) => fetch(url, { credentials: 'include' }).then((r) => r.json());
`,
      ...page('a07', `import { fetcher } from '@/lib/zzbrk2_a07_fetcher';
export function Rows() { useEffect(() => { fetcher('/api/accounting/rows').then(setRows).catch((e) => setError(apiErrorMessage(e, 'Could not load the rows - try again'))); }, []); return null; }`),
    } },
  { id: 'a08', kind: 'a', name: 'a page with getServerSideProps and raw fetch in the component: whole file excluded',
    files: { 'pages/zzbrk2/a08.tsx': `import { useEffect, useState } from 'react';
import type { GetServerSideProps } from 'next';
export const getServerSideProps: GetServerSideProps = async () => ({ props: {} });
export default function Page() {
  const [rows, setRows] = useState<unknown[]>([]);
  useEffect(() => { fetch('/api/accounting/rows').then((r) => r.json()).then(setRows); }, []);
  return <ul>{rows.length}</ul>;
}
` } },
  { id: 'a09', kind: 'a', name: 'cleanup-race guard that also tests a 401 counts as the status check',
    files: page('a09', `export function Rows() {
  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await apiFetch('/api/accounting/rows');
      if (!alive || res.status === 401) return;
      setRows(await res.json());
    })();
    return () => { alive = false; };
  }, []);
  return null;
}`) },
  { id: 'a10', kind: 'a', name: 'switch on status with a default that falls through to the read',
    files: page('a10', `export async function load() {
  const res = await apiFetch('/api/accounting/rows');
  switch (res.status) { case 404: return []; case 401: return null; }
  return res.json();
}`) },

  // ── (b) bare / status-code message reaching a person ──────────────────────
  { id: 'b01', kind: 'b', name: 'message passed as a JSX attribute',
    files: page('b01', `const ErrorBanner = ({ message }: { message: string }) => <p className="text-red-600">{message}</p>;
export const C = ({ failed }: { failed: boolean }) => (failed ? <ErrorBanner message="Something went wrong" /> : null);`) },
  { id: 'b02', kind: 'b', name: '"An unexpected error occurred"',
    files: page('b02', `export function f() { setError('An unexpected error occurred'); }`) },
  { id: 'b03', kind: 'b', name: '"Something went wrong. Please try again."',
    files: page('b03', `export function f() { toast.error('Something went wrong. Please try again.'); }`) },
  { id: 'b04', kind: 'b', name: '"Network error"',
    files: page('b04', `export function f() { setError('Network error'); }`) },
  { id: 'b05', kind: 'b', name: 'status destructured, then templated',
    files: page('b05', `export async function f() { const res = await apiFetch('/api/x'); if (!res.ok) { const { status } = res; setError(\`Server responded \${status}\`); return; } setRows(await res.json()); }`) },
  { id: 'b06', kind: 'b', name: 'status concatenated after a non-bare prefix',
    files: page('b06', `export async function f() { const res = await apiFetch('/api/x'); if (!res.ok) { toast.error('Request failed with status ' + res.status); return; } setRows(await res.json()); }`) },
  { id: 'b07', kind: 'b', name: 'message built in a src/lib util (never selected), then toasted',
    files: {
      'src/lib/zzbrk2_b07_msg.ts': `export function failureText(status: number): string {
  return status >= 500 ? 'Server error' : 'Request failed';
}
`,
      ...page('b07', `import { failureText } from '@/lib/zzbrk2_b07_msg';
export async function f() { const res = await apiFetch('/api/x'); if (!res.ok) { toast.error(failureText(res.status)); return; } setRows(await res.json()); }`),
    } },
  { id: 'b08', kind: 'b', name: 'status -> message lookup table',
    files: page('b08', `const MESSAGES: Record<number, string> = { 403: 'Forbidden', 500: 'Server error' };
export async function f() { const res = await apiFetch('/api/x'); if (!res.ok) { setError(MESSAGES[res.status] ?? 'Could not load the rows - try again'); return; } setRows(await res.json()); }`) },
  { id: 'b09', kind: 'b', name: 'fallback by assignment, not by ||',
    files: page('b09', `export async function f(data: { error?: string }) { let message = data.error; if (!message) message = 'Failed'; setError(message); }`) },
  { id: 'b10', kind: 'b', name: 'JSX text beside an expression child',
    files: page('b10', `export const C = ({ failed, retry }: { failed: boolean; retry: () => void }) => (failed ? <p>Something went wrong {retry && <button onClick={retry}>Retry</button>}</p> : null);`) },
  { id: 'b11', kind: 'b', name: 'apiJson imported under another name: no sentence, not seen',
    files: { 'pages/zzbrk2/b11.tsx': `import { apiJson as getJson } from '@/lib/apiFetch';
export async function f() { return getJson('/api/accounting/rows'); }
` } },
  { id: 'b12', kind: 'b', name: '"Unknown error occurred"',
    files: page('b12', `export function f() { toast.error('Unknown error occurred'); }`) },
  { id: 'b13', kind: 'b', name: 'class component state key not in the message-key list',
    files: page('b13', `export class Rows extends Component<object, { loadError: string | null }> {
  state = { loadError: null as string | null };
  async componentDidMount() {
    try { setRows(await apiJson('/api/accounting/rows', undefined, 'Could not load the rows - try again')); }
    catch { this.setState({ loadError: 'Failed' }); }
  }
  render() { return this.state.loadError ? <p>{this.state.loadError}</p> : null; }
}`) },

  // ── (c) raw error text ────────────────────────────────────────────────────
  { id: 'c01', kind: 'c', name: '.catch(setError) — the setter itself is the handler',
    files: page('c01', `export function Rows() {
  const [error, setErr] = useState<unknown>(null);
  useEffect(() => { apiJson('/api/accounting/rows', undefined, 'Could not load the rows - try again').then(setRows).catch(setErr); }, []);
  return error ? <p>{String(error)}</p> : null;
}`) },
  { id: 'c02', kind: 'c', name: 'class component keeps the Error in state and renders .message',
    files: page('c02', `export class Rows extends Component<object, { error: Error | null }> {
  state = { error: null as Error | null };
  async componentDidMount() {
    try { const res = await apiFetch('/api/accounting/rows'); await assertOk(res, 'Could not load the rows - try again'); setRows(await res.json()); }
    catch (err) { this.setState({ error: err as Error }); }
  }
  render() { return this.state.error ? <p>{this.state.error.message}</p> : null; }
}`) },
  { id: 'c03', kind: 'c', name: 'useReducer: error object dispatched, .message rendered',
    files: page('c03', `type S = { error: Error | null };
const reducer = (s: S, a: { type: 'failed'; error: Error }) => ({ ...s, error: a.error });
export function Rows() {
  const [state, dispatch] = useReducer(reducer, { error: null });
  useEffect(() => { apiJson('/api/accounting/rows', undefined, 'Could not load the rows - try again').then(setRows).catch((err) => dispatch({ type: 'failed', error: err })); }, []);
  return state.error ? <p>{state.error.message}</p> : null;
}`) },
  { id: 'c04', kind: 'c', name: 'Promise.allSettled: the rejected reason .message shown',
    files: page('c04', `export async function f() {
  const results = await Promise.allSettled([apiJson('/api/a', undefined, 'Could not load a'), apiJson('/api/b', undefined, 'Could not load b')]);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) setError(failed.reason.message);
}`) },
  { id: 'c05', kind: 'c', name: 'error text built in a src/lib util, then toasted',
    files: {
      'src/lib/zzbrk2_c05_err.ts': `export const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Could not complete the request - try again');
`,
      ...page('c05', `import { errorText } from '@/lib/zzbrk2_c05_err';
export async function f() { try { await apiJson('/api/x', ${W}, 'Could not save - try again'); } catch (e) { toast.error(errorText(e)); } }`),
    } },
  { id: 'c06', kind: 'c', name: 'hook keeps the Error (ternary into the setter); page renders .message',
    files: {
      'src/hooks/zzbrk2_c06_useRows.ts': `import { useEffect, useState } from 'react';
import { apiJson } from '@/lib/apiFetch';
export function useRows() {
  const [rows, setRows] = useState<unknown>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    void (async () => {
      try { setRows(await apiJson('/api/accounting/rows', undefined, 'Could not load the rows - try again')); }
      catch (e) { setRows(null); setError(e instanceof Error ? e : null); }
    })();
  }, []);
  return { rows, error };
}
`,
      'pages/zzbrk2/c06.tsx': `import { useRows } from '@/hooks/zzbrk2_c06_useRows';
export default function Page() { const { error } = useRows(); return error ? <p>{error.message}</p> : null; }
`,
    } },
  { id: 'c07', kind: 'c', name: 'message destructured in the catch body',
    files: page('c07', `export async function f() { try { await apiJson('/api/x', ${W}, 'Could not save - try again'); } catch (err) { const { message } = err as Error; toast.error(message); } }`) },
  { id: 'c08', kind: 'c', name: '.catch(handler) where the handler is a useCallback',
    files: page('c08', `export function Rows() {
  const showError = useCallback((e: Error) => toast.error(e.message), []);
  useEffect(() => { apiJson('/api/accounting/rows', undefined, 'Could not load the rows - try again').then(setRows).catch(showError); }, [showError]);
  return null;
}`) },
  { id: 'c09', kind: 'c', name: 'catch hands the error to a local handleError that shows .message',
    files: page('c09', `export function Save() {
  const handleError = useCallback((e: unknown) => setError((e as Error).message), []);
  const save = async () => { try { await apiJson('/api/x', ${W}, 'Could not save - try again'); } catch (err) { handleError(err); } };
  return <button onClick={save}>Save</button>;
}`) },
  { id: 'c10', kind: 'c', name: 'errors collected into a list, rendered with String()',
    files: page('c10', `export function Bulk({ ids }: { ids: string[] }) {
  const [errors, setErrors] = useState<unknown[]>([]);
  const run = async () => { for (const id of ids) { try { await apiJson(\`/api/x/\${id}\`, { method: 'DELETE' }, 'Could not delete - try again'); } catch (err) { setErrors((prev) => [...prev, err]); } } };
  return <div onClick={run}>{errors.map((e, i) => <p key={i}>{String(e)}</p>)}</div>;
}`) },

  // ── (d) write whose failure is never acted on ─────────────────────────────
  { id: 'd01', kind: 'd', name: 'Promise.allSettled bulk delete counts only rejections (a 500 is fulfilled)',
    files: page('d01', `export async function bulkDelete(ids: string[]) {
  const results = await Promise.allSettled(ids.map((id) => apiFetch(\`/api/accounting/rows/\${id}\`, { method: 'DELETE' })));
  let failed = 0;
  results.forEach((r) => { if (r.status === 'rejected') failed++; });
  if (failed) setError(\`Could not delete \${failed} rows - try again\`);
  await reload();
}`) },
  { id: 'd02', kind: 'd', name: 'success toast on ok, then the modal closes either way',
    files: page('d02', `export async function save(onClose: () => void) {
  const res = await apiFetch('/api/accounting/rows', ${W});
  if (res.ok) toast.success('Saved');
  onClose();
}`) },
  { id: 'd03', kind: 'd', name: 'write returns res.ok to a caller that ignores the boolean',
    files: page('d03', `async function save(body: unknown): Promise<boolean> {
  const res = await apiFetch('/api/accounting/rows', { method: 'POST', body: JSON.stringify(body) });
  return res.ok;
}
export async function onSubmit(body: unknown, close: () => void) { await save(body); close(); }`) },
  { id: 'd04', kind: 'd', stated: true, name: 'write wrapper exported from src/lib, caller ignores the result',
    files: {
      'src/lib/zzbrk2_d04_api.ts': `import { apiFetch } from '@/lib/apiFetch';
export const archiveRow = (id: string) => apiFetch(\`/api/accounting/rows/\${id}/archive\`, { method: 'POST' });
`,
      ...page('d04', `import { archiveRow } from '@/lib/zzbrk2_d04_api';
export async function onArchive(id: string) { await archiveRow(id); await reload(); }`),
    } },
  { id: 'd05', kind: 'd', stated: true, name: 'hook returns { save }; caller ignores the response',
    files: {
      'src/hooks/zzbrk2_d05_useSave.ts': `import { apiFetch } from '@/lib/apiFetch';
export function useSave() {
  const save = (body: unknown) => apiFetch('/api/accounting/rows', { method: 'POST', body: JSON.stringify(body) });
  return { save };
}
`,
      'pages/zzbrk2/d05.tsx': `import { useSave } from '@/hooks/zzbrk2_d05_useSave';
export default function Page({ close }: { close: () => void }) { const { save } = useSave(); return <button onClick={async () => { await save({}); close(); }}>Save</button>; }
`,
    } },
  { id: 'd06', kind: 'd', name: 'apiFetch imported under another name',
    files: { 'pages/zzbrk2/d06.tsx': `import { apiFetch as request } from '@/lib/apiFetch';
declare const reload: () => Promise<void>;
export async function onDelete(id: string) { await request(\`/api/accounting/rows/\${id}\`, { method: 'DELETE' }); await reload(); }
` } },
  { id: 'd07', kind: 'd', name: '.then: only a 201 is acted on, every failure dropped',
    files: page('d07', `export function create(onCreated: () => void) {
  void apiFetch('/api/accounting/rows', ${W}).then((r) => { if (r.status === 201) onCreated(); });
}`) },
  { id: 'd08', kind: 'd', name: 'response handed to a local handler that only looks for a 409',
    files: page('d08', `export async function create() {
  const handle = (r: Response) => { if (r.status === 409) setError('That code is already in use - pick another'); };
  handle(await apiFetch('/api/accounting/rows', ${W}));
  await reload();
}`) },
  { id: 'd09', kind: 'd', name: 'assertOk only in one branch; the other branch navigates away',
    files: page('d09', `export async function save(mode: 'draft' | 'final', go: (u: string) => void) {
  const res = await apiFetch('/api/accounting/journals', ${W});
  if (mode === 'draft') { await assertOk(res, 'Could not save the draft - try again'); }
  go('/accounting/journals');
}`) },

  // ── (e) busy flag stuck on a thrown error ──────────────────────────────────
  { id: 'e01', kind: 'e', name: 'setUploading(true), no finally',
    files: page('e01', `export function Up() {
  const [, setUploading] = useState(false);
  const upload = async (form: FormData) => { setUploading(true); await apiJson('/api/x', { method: 'POST', body: form }, 'Could not upload the file - try again'); setUploading(false); };
  return <input onChange={() => upload(new FormData())} />;
}`) },
  { id: 'e02', kind: 'e', name: 'useEffect .then().catch() chain, loading only cleared on success',
    files: page('e02', `export function Rows() {
  const [, setLoading] = useState(false);
  useEffect(() => {
    setLoading(true);
    apiJson('/api/accounting/rows', undefined, 'Could not load the rows - try again')
      .then((d) => { setRows(d); setLoading(false); })
      .catch((e) => setError(apiErrorMessage(e, 'Could not load the rows - try again')));
  }, []);
  return null;
}`) },
  { id: 'e03', kind: 'e', name: 'class component this.setState({ saving: true }), no finally',
    files: page('e03', `export class Save extends Component<object, { saving: boolean }> {
  state = { saving: false };
  save = async () => {
    this.setState({ saving: true });
    await apiJson('/api/x', ${W}, 'Could not save - try again');
    this.setState({ saving: false });
  };
  render() { return <button disabled={this.state.saving} onClick={this.save}>Save</button>; }
}`) },
  { id: 'e04', kind: 'e', name: 'finally exists but the first await is outside the try',
    files: page('e04', `export function Save({ onSaved }: { onSaved: () => void }) {
  const [, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const res = await apiFetch('/api/accounting/rows', ${W});
    try { await assertOk(res, 'Could not save - try again'); onSaved(); }
    catch (e) { setError(apiErrorMessage(e, 'Could not save - try again')); }
    finally { setSaving(false); }
  };
  return <button onClick={save}>Save</button>;
}`) },
  { id: 'e05', kind: 'e', name: 'status machine setStatus(\'loading\'), no finally',
    files: page('e05', `export function Rows() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'done'>('idle');
  const load = async () => { setStatus('loading'); setRows(await apiJson('/api/accounting/rows', undefined, 'Could not load the rows - try again')); setStatus('done'); };
  return <button disabled={status === 'loading'} onClick={load}>Load</button>;
}`) },

  // ── (f) failed load keeps the stale rows ───────────────────────────────────
  { id: 'f01', kind: 'f', name: 'apiJson load (the recommended helper): catch shows an error, rows kept',
    files: page('f01', `export function Rows({ period }: { period: string }) {
  const [rows, setRowsState] = useState<unknown>(null);
  const load = async () => {
    try { const data = await apiJson(\`/api/accounting/rows?period=\${period}\`, undefined, 'Could not load the rows - try again'); setRowsState(data); }
    catch (e) { setError(apiErrorMessage(e, 'Could not load the rows - try again')); }
  };
  return <div onClick={load}>{String(rows)}</div>;
}`) },
  { id: 'f02', kind: 'f', name: 'body destructured: catch shows an error, rows kept',
    files: page('f02', `export function Rows({ period }: { period: string }) {
  const [rows, setRowsState] = useState<unknown[]>([]);
  const load = async () => {
    try { const res = await apiFetch(\`/api/accounting/rows?period=\${period}\`); await assertOk(res, 'Could not load the rows - try again'); const { items } = await res.json(); setRowsState(items); }
    catch (e) { setError(apiErrorMessage(e, 'Could not load the rows - try again')); }
  };
  return <div onClick={load}>{rows.length}</div>;
}`) },
  { id: 'f03', kind: 'f', name: '.then/.catch load: catch shows an error, rows kept',
    files: page('f03', `export function Rows({ period }: { period: string }) {
  const [rows, setRowsState] = useState<unknown>(null);
  useEffect(() => {
    apiJson(\`/api/accounting/rows?period=\${period}\`, undefined, 'Could not load the rows - try again')
      .then(setRowsState)
      .catch((e) => setError(apiErrorMessage(e, 'Could not load the rows - try again')));
  }, [period]);
  return <div>{String(rows)}</div>;
}`) },

  // ── (g) failure dropped without a word ────────────────────────────────────
  { id: 'g01', kind: 'g', name: 'if (res.status !== 200) return;',
    files: page('g01', `export async function load() { const res = await apiFetch('/api/accounting/rows'); if (res.status !== 200) return; setRows(await res.json()); }`) },
  { id: 'g02', kind: 'g', name: 'if (!res.ok) return [];',
    files: page('g02', `export async function load() { const res = await apiFetch('/api/accounting/rows'); if (!res.ok) return []; return res.json(); }`) },
  { id: 'g03', kind: 'g', name: 'cleanup race: if (cancelled || !res.ok) return;',
    files: page('g03', `export function Rows() {
  useEffect(() => {
    let cancelled = false;
    void (async () => { const res = await apiFetch('/api/accounting/rows'); if (cancelled || !res.ok) return; setRows(await res.json()); })();
    return () => { cancelled = true; };
  }, []);
  return null;
}`) },
  { id: 'g04', kind: 'g', name: 'if (res.ok) {...} with a statement after it',
    files: page('g04', `export function Rows() {
  const [, setLoading] = useState(true);
  useEffect(() => { void (async () => { const res = await apiFetch('/api/accounting/rows'); if (res.ok) { setRows(await res.json()); } setLoading(false); })(); }, []);
  return null;
}`) },
  { id: 'g05', kind: 'g', name: 'if (!res.ok) { setLoading(false); return; }',
    files: page('g05', `export function Rows() {
  const [, setLoading] = useState(true);
  useEffect(() => { void (async () => { const res = await apiFetch('/api/accounting/rows'); if (!res.ok) { setLoading(false); return; } setRows(await res.json()); setLoading(false); })(); }, []);
  return null;
}`) },
];

/** Correct code: each must produce NO hit of any kind. */
export const NEGATIVES: Fx[] = [
  { id: 'n01', kind: 'd', name: 'write checked through .then((r) => r.ok)',
    files: page('n01', `export async function save() { const ok = await apiFetch('/api/x', ${W}).then((r) => r.ok); if (!ok) { setError('Could not save - try again'); return; } await reload(); }`) },
  { id: 'n02', kind: 'a', name: 'allSettled: fulfilled AND value.ok checked, then value read',
    files: page('n02', `export async function f() { const out: unknown[] = []; const rs = await Promise.allSettled([apiFetch('/api/a')]); for (const r of rs) { if (r.status === 'fulfilled' && r.value.ok) out.push(await r.value.json()); else setError('Could not load a - try again'); } return out; }`) },
  { id: 'n03', kind: 'c', name: 'err.message only tested, never shown',
    files: page('n03', `export async function f() { try { await apiJson('/api/x', ${W}, 'Could not save - try again'); } catch (err) { if ((err as Error).message.includes('aborted')) return; setError(apiErrorMessage(err, 'Could not save - try again')); } }`) },
  { id: 'n04', kind: 'd', name: 'useCallback write wrapper; the caller checks',
    files: page('n04', `export function Save() {
  const send = useCallback((b: unknown) => apiFetch('/api/x', { method: 'POST', body: JSON.stringify(b) }), []);
  const save = async () => { const res = await send({}); await assertOk(res, 'Could not save - try again'); };
  return <button onClick={save}>Save</button>;
}`) },
  { id: 'n05', kind: 'e', name: '.then chain with .finally clearing loading',
    files: page('n05', `export function Rows() { const [, setLoading] = useState(false); useEffect(() => { setLoading(true); apiJson('/api/r', undefined, 'Could not load the rows - try again').then(setRows).catch((e) => { setRows(null); setError(apiErrorMessage(e, 'Could not load the rows - try again')); }).finally(() => setLoading(false)); }, []); return null; }`) },
  { id: 'n06', kind: 'e', name: 'async load with try/finally',
    files: page('n06', `export function Rows() { const [, setLoading] = useState(false); const load = async () => { setLoading(true); try { setRows(await apiJson('/api/r', undefined, 'Could not load the rows - try again')); } catch (e) { setRows(null); setError(apiErrorMessage(e, 'Could not load the rows - try again')); } finally { setLoading(false); } }; return <button onClick={load} />; }`) },
  { id: 'n07', kind: 'g', name: 'if (!res.ok) return setError(sentence)',
    files: page('n07', `export async function f() { const res = await apiFetch('/api/r'); if (!res.ok) return setError('Could not load the rows - try again'); setRows(await res.json()); }`) },
  { id: 'n08', kind: 'a', name: 'GET with an AbortSignal, assertOk',
    files: page('n08', `export async function f(signal: AbortSignal) { const res = await apiFetch('/api/r', { signal }); await assertOk(res, 'Could not load the rows - try again'); return res.json(); }`) },
  { id: 'n09', kind: 'a', name: 'Promise.all of GETs, Promise.all of assertOk',
    files: page('n09', `export async function f() { const [a, b] = await Promise.all([apiFetch('/api/a'), apiFetch('/api/b')]); await Promise.all([assertOk(a, 'Could not load a - try again'), assertOk(b, 'Could not load b - try again')]); return [await a.json(), await b.json()]; }`) },
  { id: 'n10', kind: 'b', name: 'status label in a table cell',
    files: page('n10', `export const Cell = ({ row }: { row: { status: string } }) => <td>{row.status === 'failed' ? 'Failed' : 'Sent'}</td>;`) },
  { id: 'n11', kind: 'b', name: 'filter option labelled Error',
    files: page('n11', `export const Filter = () => <select><option value="all">All</option><option value="error">Error</option></select>;`) },
  { id: 'n12', kind: 'f', name: 'apiJson load that clears rows in catch',
    files: page('n12', `export function Rows() { const [rows, setR] = useState<unknown>(null); const load = async () => { try { const d = await apiJson('/api/r', undefined, 'Could not load the rows - try again'); setR(d); } catch (e) { setR(null); setError(apiErrorMessage(e, 'Could not load the rows - try again')); } }; return <div onClick={load}>{String(rows)}</div>; }`) },
  { id: 'n13', kind: 'c', name: 'class component, apiErrorMessage into state',
    files: page('n13', `export class Rows extends Component<object, { error: string | null }> { state = { error: null as string | null }; async componentDidMount() { try { setRows(await apiJson('/api/r', undefined, 'Could not load the rows - try again')); } catch (err) { this.setState({ error: apiErrorMessage(err, 'Could not load the rows - try again') }); } } render() { return this.state.error; } }`) },
  { id: 'n14', kind: 'd', name: 'DELETE checked against 204',
    files: page('n14', `export async function del(id: string) { const res = await apiFetch(\`/api/r/\${id}\`, { method: 'DELETE' }); if (res.status !== 204) throw new Error('Could not delete the row - try again'); await reload(); }`) },
  { id: 'n15', kind: 'c', name: '.catch -> toast.error(apiErrorMessage(..))',
    files: page('n15', `export function f() { apiJson('/api/x', ${W}, 'Could not save - try again').then(reload).catch((e) => toast.error(apiErrorMessage(e, 'Could not save - try again'))); }`) },
  { id: 'n16', kind: 'a', name: 'switch on status, default throws',
    files: page('n16', `export async function f() { const res = await apiFetch('/api/r'); switch (res.status) { case 200: return res.json(); case 404: return null; default: throw new Error('Could not load the rows - try again'); } }`) },
];

/** The shapes the gate does not claim to see, one line each, with the fixtures that are the example. */
export const LIMIT_GROUPS: Record<string, { why: string; ids: string[] }> = {
  singleStatusCode: { why: 'a test for ONE status code (404, 204, 401) is counted as the status check, so the other statuses reach the body read', ids: ['a01', 'a04', 'a09', 'd07', 'd08'] },
  statusJudgedLater: { why: 'a status copied to a const and judged after the body is read is not a check that precedes it', ids: ['a02'] },
  anyTyped: { why: 'a value derived from a response body (or an undeclared name) is any, not a Response, to the type checker', ids: ['a03'] },
  messageBuilt: { why: 'a message built from a destructured status, a lookup table, an assignment, or in another module is not followed', ids: ['b05', 'b07', 'b08', 'b09'] },
  errorHeldElsewhere: { why: 'a caught error stored in a reducer, class state, a settled `reason` or an array, or turned into text by a helper in another file, is not followed to where it is shown', ids: ['c02', 'c03', 'c04', 'c05', 'c06', 'c10'] },
  writeResultHandedOn: { why: 'a write whose result is returned from a hook or a wrapper in another module, reduced to a boolean the caller ignores, or checked on one branch only, is not followed', ids: ['d02', 'd03', 'd04', 'd05', 'd09'] },
  busyFlagShapes: { why: 'busy flags outside an async function with a setX(true) call: a .then chain, a class component, a try after the await, a status string', ids: ['e02', 'e03', 'e04', 'e05'] },
  loadShapes: { why: 'a failed load is recognised only when the body is bound with `const x = await res.json()`: a load through apiJson, a destructured body or .then(setRows) is not (the gate asks for the reset everywhere on purpose, and widening it flagged ~15 correct reset-before-try loads)', ids: ['f01', 'f02', 'f03'] },
};
const GROUP_OF = new Map(Object.entries(LIMIT_GROUPS).flatMap(([g, v]) => v.ids.map((id) => [id, g] as const)));

export type Fixture = Fx & { expectedLimit: boolean; limitGroup?: string };
export const FIXTURES: Fixture[] = RAW_FIXTURES.map((f) => ({ ...f, expectedLimit: GROUP_OF.has(f.id), limitGroup: GROUP_OF.get(f.id) }));
