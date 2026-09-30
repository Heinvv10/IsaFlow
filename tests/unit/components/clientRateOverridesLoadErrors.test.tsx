/**
 * R-164: `loadData` ignored a non-ok response from either the overrides or
 * the staff endpoint, so a 500 rendered as "No rate overrides yet" / an empty
 * staff dropdown — indistinguishable from a client that genuinely has none.
 * Same flaw in `handleDelete`, which never checked the DELETE response.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClientRateOverrides } from '@/components/practice/ClientRateOverrides';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch');
  return { ...actual, apiFetch: vi.fn() };
});

const OVERRIDE = {
  id: 'ro-1', staffUserId: 'u1', ratePerHour: 500, effectiveFrom: '2026-09-01',
  effectiveTo: null, notes: null, staffEmail: 'a@b.com', staffName: 'A B',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function answers({ overrides, staff }: { overrides: Response; staff: Response }) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/staff')) return staff;
    if (path.endsWith('/rate-overrides')) return overrides;
    return json({ success: true, data: [] });
  });
}

beforeEach(() => {});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows an error, not "No rate overrides yet", when the overrides call 500s', async () => {
  answers({
    overrides: json({ success: false, error: { message: 'db down' } }, 500),
    staff: json({ success: true, data: [] }),
  });
  render(<ClientRateOverrides clientId="c1" />);

  expect(await screen.findByText('db down')).toBeInTheDocument();
  expect(screen.queryByText('No rate overrides yet')).not.toBeInTheDocument();
});

it('shows an error when the staff call 500s, even though overrides load fine', async () => {
  answers({
    overrides: json({ success: true, data: [OVERRIDE] }),
    staff: json({ success: false, error: { message: 'staff lookup failed' } }, 500),
  });
  render(<ClientRateOverrides clientId="c1" />);

  expect(await screen.findByText('staff lookup failed')).toBeInTheDocument();
});

it('renders overrides and staff normally on 200', async () => {
  answers({
    overrides: json({ success: true, data: [OVERRIDE] }),
    staff: json({ success: true, data: [{ userId: 'u1', email: 'a@b.com', fullName: 'A B' }] }),
  });
  render(<ClientRateOverrides clientId="c1" />);

  expect(await screen.findByText('A B')).toBeInTheDocument();
  expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument();
});

it('shows an error when deleting an override 500s, instead of silently reloading', async () => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (init?.method === 'DELETE') return json({ success: false, error: { message: 'delete failed' } }, 500);
    if (path.endsWith('/staff')) return json({ success: true, data: [] });
    return json({ success: true, data: [OVERRIDE] });
  });
  render(<ClientRateOverrides clientId="c1" />);

  fireEvent.click(await screen.findByTitle('Delete override'));
  expect(await screen.findByText('delete failed')).toBeInTheDocument();
  // The row must still be there — the delete never actually succeeded.
  expect(screen.getByText('A B')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTitle('Delete override')).not.toBeDisabled());
});
