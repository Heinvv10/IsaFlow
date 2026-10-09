/**
 * R-035 PR A, folded in from the round-2 adversarial review (prA-adv-r2): the
 * delete confirmation sends one DELETE and nothing on Escape, and one rule's
 * write cannot re-enable another rule's buttons while that write is in flight
 * (busy is per rule).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { json, rule, serve } from '../helpers/approvalRulesServe';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
afterEach(() => { cleanup(); });

async function openRules() {
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^rules$/i }));
}

it('a double-click on "Delete rule" sends ONE DELETE', async () => {
  const sent = serve({ rules: [rule()], actorRole: 'admin' });
  await openRules();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Big bills' }));
  const confirm = within(await screen.findByRole('dialog', { name: 'Delete approval rule?' })).getByRole('button', { name: 'Delete rule' });
  fireEvent.click(confirm); fireEvent.click(confirm); // two discrete events, as a browser dispatches them
  await waitFor(() => expect(sent.length).toBeGreaterThan(0));
  expect(sent.filter((s) => s.method === 'DELETE')).toHaveLength(1);
});

it('Escape / Cancel on the confirmation sends nothing', async () => {
  const sent = serve({ rules: [rule()], actorRole: 'admin' });
  await openRules();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Big bills' }));
  await screen.findByRole('dialog', { name: 'Delete approval rule?' });
  await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(sent).toEqual([]);
});

it('a second write while the first one\'s reload is pending: its row stays disabled until ITS write is done', async () => {
  const a = rule({ id: 'a', name: 'Rule A' });
  const b = rule({ id: 'b', name: 'Rule B' });
  let releaseA: (r: Response) => void = () => undefined;
  const gets: (() => Promise<Response> | Response)[] = [
    () => json({ success: true, data: { items: [a, b], actorRole: 'admin' } }),
    () => json({ success: true, data: { items: [a, b], actorRole: 'admin' } }),
    () => new Promise<Response>((r) => { releaseA = r; }),
  ];
  let n = 0;
  let releaseBPut: (r: Response) => void = () => undefined;
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    if (path.startsWith('/api/accounting/approval-rules') && method === 'GET') {
      const g = gets[Math.min(n, gets.length - 1)]!; n += 1; return g();
    }
    if (path.startsWith('/api/accounting/approval-rules') && method === 'PUT') {
      const body = JSON.parse(String(init!.body));
      if (body.id === 'b') return new Promise<Response>((r) => { releaseBPut = r; });
      return json({ success: true, data: {} });
    }
    if (path.startsWith('/api/accounting/approval-enforcement')) return json({ success: true, data: { items: [], enforceable: [], preview: {} } });
    return json({ success: true, data: { items: [] } });
  });
  await openRules();
  const toggleA = await screen.findByRole('button', { name: 'Deactivate Rule A' });
  await act(async () => { fireEvent.click(toggleA); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deactivate Rule B' })); });
  // A's write finishes (its reload resolves) while B's PUT is still in flight.
  gets.push(() => json({ success: true, data: { items: [a, b], actorRole: 'admin' } }));
  await act(async () => { releaseA(json({ success: true, data: { items: [a, b], actorRole: 'admin' } })); });
  expect((screen.getByRole('button', { name: 'Deactivate Rule B' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { releaseBPut(json({ success: true, data: {} })); });
});
