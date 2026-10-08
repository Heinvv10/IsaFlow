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
