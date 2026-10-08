/**
 * R-035 follow-up PR A, review round 1 (blind LOW): after a rule write the Rules
 * tab reloads its list. A failed reload must say so — never "No approval rules
 * configured" while the company has rules — and a late, older reload must not
 * overwrite a newer one.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { json, refusal, rule } from '../helpers/approvalRulesServe';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

afterEach(() => { cleanup(); });

const list = (items: ReturnType<typeof rule>[]) => json({ success: true, data: { items, actorRole: 'owner' } });

/** Rules GETs are answered by `gets` in order (the last one repeats); everything else succeeds. */
function serveGets(gets: (() => Promise<Response> | Response)[]) {
  let n = 0;
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-rules') && (init?.method ?? 'GET') === 'GET') {
      const answer = gets[Math.min(n, gets.length - 1)]!;
      n += 1;
      return answer();
    }
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      return json({ success: true, data: { items: [], enforceable: [], preview: {} } });
    }
    return json({ success: true, data: { items: [] } });
  });
}

async function openRules() {
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^rules$/i }));
}

it('a reload that fails after a write shows its error, and does not claim the company has no rules', async () => {
  const a = rule({ id: 'a', name: 'Rule A' });
  serveGets([() => list([a]), () => list([a]), () => refusal(503, 'Rules are unavailable right now')]);
  await openRules();
  const toggle = await screen.findByRole('button', { name: 'Deactivate Rule A' });
  await act(async () => { fireEvent.click(toggle); });
  expect(await screen.findByText('Rules are unavailable right now')).toBeDefined();
  expect(screen.queryByText('No approval rules configured')).toBeNull();
  expect(screen.getByText('The rules could not be loaded, so they are not shown.')).toBeDefined();
});

it('a late reload from an earlier write does not overwrite a newer one', async () => {
  const a = rule({ id: 'a', name: 'Rule A' });
  const b = rule({ id: 'b', name: 'Rule B' });
  let releaseOld: (r: Response) => void = () => undefined;
  const old = new Promise<Response>((resolve) => { releaseOld = resolve; });
  serveGets([
    () => list([a, b]), () => list([a, b]), // initial page load, then the Rules tab's own load
    () => old, // the reload after the first write: answers late, with the old names
    () => list([{ ...a, name: 'Rule A (new)' }, { ...b, name: 'Rule B (new)' }]),
  ]);
  await openRules();
  const toggleA = await screen.findByRole('button', { name: 'Deactivate Rule A' });
  await act(async () => { fireEvent.click(toggleA); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deactivate Rule B' })); });
  expect(await screen.findByText('Rule B (new)')).toBeDefined();
  await act(async () => { releaseOld(list([a, b])); });
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u, i]) =>
    String(u).startsWith('/api/accounting/approval-rules') && !i?.method).length).toBe(4));
  await act(async () => {});
  expect(screen.getByText('Rule A (new)')).toBeDefined();
  expect(screen.queryByText('Rule A')).toBeNull();
});

// Review round 2 (blind LOW 1): the page's own load (fetchData) is sequenced too —
// a slow load from an earlier tab must not overwrite the rules, the requests or
// the error of a newer one.
const request = (id: string, reference: string, status = 'pending') => ({
  id, documentType: 'supplier_invoice', documentId: `doc-${id}`, documentReference: reference, amount: 100,
  documentDigest: null, status, requestedByName: 'R', requestedAt: '2026-10-01T00:00:00Z', decidedAt: null, decisionNotes: null,
});

/** The first page load (both its GETs) answers only when `release` is called; every later load answers at once. */
function serveSlowFirstLoad(first: { requests: () => Response; rules: () => Response }, later: { requests: unknown[]; rules: unknown[] }) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const seen = { requests: 0, rules: 0 };
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if ((init?.method ?? 'GET') !== 'GET') return json({ success: true, data: {} });
    for (const kind of ['requests', 'rules'] as const) {
      if (!path.startsWith(`/api/accounting/approval-${kind}`)) continue;
      seen[kind] += 1;
      if (seen[kind] === 1) { await gate; return first[kind](); }
      return json({ success: true, data: { items: later[kind], actorRole: 'owner' } });
    }
    if (path.startsWith('/api/accounting/approval-enforcement')) return json({ success: true, data: { items: [], enforceable: [], preview: {} } });
    return json({ success: true, data: { items: [] } });
  });
  return () => release();
}

it('a slow first load does not overwrite the newer requests list (pending → history)', async () => {
  const release = serveSlowFirstLoad(
    { requests: () => json({ success: true, data: { items: [request('o', 'OLD-PENDING')] } }), rules: () => list([]) },
    { requests: [request('n', 'NEW-HISTORY', 'approved')], rules: [] });
  render(<ApprovalsPage />);
  fireEvent.click(screen.getByRole('button', { name: /^history$/i }));
  expect(await screen.findByText('NEW-HISTORY')).toBeDefined();
  await act(async () => { release(); });
  await act(async () => {});
  expect(screen.queryByText('OLD-PENDING')).toBeNull();
  expect(screen.getByText('NEW-HISTORY')).toBeDefined();
});

it('a slow first load that fails does not show its error over the newer load', async () => {
  const release = serveSlowFirstLoad(
    { requests: () => refusal(503, 'The old load failed'), rules: () => list([]) },
    { requests: [request('n', 'NEW-HISTORY', 'approved')], rules: [] });
  render(<ApprovalsPage />);
  fireEvent.click(screen.getByRole('button', { name: /^history$/i }));
  expect(await screen.findByText('NEW-HISTORY')).toBeDefined();
  await act(async () => { release(); });
  await act(async () => {});
  expect(screen.queryByText('The old load failed')).toBeNull();
  expect(screen.getByText('NEW-HISTORY')).toBeDefined();
});

it('a slow first load does not overwrite the newer rules list (pending → rules)', async () => {
  const release = serveSlowFirstLoad(
    { requests: () => json({ success: true, data: { items: [] } }), rules: () => list([rule({ id: 'o', name: 'Rule from the old load' })]) },
    { requests: [], rules: [rule({ id: 'n', name: 'Rule from the new load' })] });
  render(<ApprovalsPage />);
  fireEvent.click(screen.getByRole('button', { name: /^rules$/i }));
  expect(await screen.findByText('Rule from the new load')).toBeDefined();
  await act(async () => { release(); });
  await act(async () => {});
  expect(screen.queryByText('Rule from the old load')).toBeNull();
  expect(screen.getByText('Rule from the new load')).toBeDefined();
});
