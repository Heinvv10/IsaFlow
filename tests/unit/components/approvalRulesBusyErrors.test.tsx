/**
 * R-035 PR A, folded in from the round-3 adversarial review (prA-adv-r3): the
 * per-rule busy set is cleared on the error paths too, not only on success.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { refusal, rule, serve } from '../helpers/approvalRulesServe';
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
const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

it('a 403 on the toggle frees the row (both buttons enabled again) and shows the message', async () => {
  serve({ rules: [rule()], actorRole: 'admin', writes: { PUT: () => refusal(403, 'Only a role above manager can …') } });
  await openRules();
  const toggle = await screen.findByRole('button', { name: 'Deactivate Big bills' });
  await act(async () => { fireEvent.click(toggle); });
  expect(await screen.findByText('Only a role above manager can …')).toBeDefined();
  expect(btn('Deactivate Big bills').disabled).toBe(false);
  expect(btn('Delete Big bills').disabled).toBe(false);
});

it('a network failure (apiFetch rejects) on delete frees the row', async () => {
  serve({ rules: [rule()], actorRole: 'admin' });
  const real = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') throw new TypeError('Failed to fetch');
    return real(url, init);
  });
  await openRules();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Big bills' }));
  const confirm = within(await screen.findByRole('dialog', { name: 'Delete approval rule?' })).getByRole('button', { name: 'Delete rule' });
  await act(async () => { fireEvent.click(confirm); });
  await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
  expect(btn('Delete Big bills').disabled).toBe(false);
  expect(btn('Deactivate Big bills').disabled).toBe(false);
});

it('a failure on rule A does not free rule B while B is still in flight, and vice versa', async () => {
  const a = rule({ id: 'a', name: 'Rule A' });
  const b = rule({ id: 'b', name: 'Rule B' });
  let releaseB: (r: Response) => void = () => undefined;
  serve({ rules: [a, b], actorRole: 'admin' });
  const real = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body));
      if (body.id === 'a') return refusal(403, 'A refused');
      return new Promise<Response>((r) => { releaseB = r; });
    }
    return real(url, init);
  });
  await openRules();
  const toggleB = await screen.findByRole('button', { name: 'Deactivate Rule B' });
  await act(async () => { fireEvent.click(toggleB); });
  await act(async () => { fireEvent.click(btn('Deactivate Rule A')); });
  expect(await screen.findByText('A refused')).toBeDefined();
  expect(btn('Deactivate Rule A').disabled).toBe(false);
  expect(btn('Deactivate Rule B').disabled).toBe(true);
  await act(async () => { releaseB(new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })); });
  await waitFor(() => expect(btn('Deactivate Rule B').disabled).toBe(false));
});
