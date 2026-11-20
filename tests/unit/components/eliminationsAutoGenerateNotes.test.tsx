/**
 * Round 11: the Eliminations page shows what Auto-Generate left out (a manual row that is the same sale as a mirrored document) and what it
 * drafted with a flag (possibly the same sale), each with its reason. It used to drop the route's `skipped` list on the floor.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import EliminationsPage from '@/../pages/accounting/group/eliminations';
import { parseSkipped } from '@/components/accounting/group/EliminationsSkippedNotice';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GROUP = '80000000-0000-4000-8000-000000000001';
const SKIPPED = [
  { transactionId: 'aaaaaaaa-0000-4000-8000-000000000001', action: 'skipped', reason: 'the same sale as a mirrored document (same two companies, amount and date), whose elimination is derived' },
  { transactionId: 'bbbbbbbb-0000-4000-8000-000000000002', action: 'flagged', reason: 'possibly the same sale as a mirrored document: 1 mirrored and 2 manual rows share the two companies, amount and date; check before posting' },
];

function serve(skipped: unknown) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('company-groups')) return new Response(JSON.stringify({ success: true, data: [{ id: GROUP, name: 'Group' }] }), { status: 200 });
    if (init?.method === 'POST') return new Response(JSON.stringify({ success: true, data: { items: [], count: 0, skipped } }), { status: 200 });
    return new Response(JSON.stringify({ success: true, data: { items: [] } }), { status: 200 });
  });
}

describe('Auto-Generate shows the skipped and flagged rows', () => {
  it('one skipped and one flagged row: both listed with their reasons; Dismiss clears them', async () => {
    serve(SKIPPED);
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-generate/i }));
    const notes = await screen.findByRole('status', { name: 'Auto-generate notes' });
    expect(within(notes).getByText(/1 manual intercompany row was not eliminated/)).toBeTruthy();
    expect(within(notes).getByText(/1 elimination was drafted with a flag/)).toBeTruthy();
    expect(within(notes).getByText(/whose elimination is derived/)).toBeTruthy();
    expect(within(notes).getByText(/check before posting/)).toBeTruthy();
    expect(within(notes).getByText('aaaaaaaa')).toBeTruthy();
    fireEvent.click(within(notes).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status', { name: 'Auto-generate notes' })).toBeNull();
  });

  it('nothing skipped: no notice', async () => {
    serve([]);
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-generate/i }));
    await screen.findByRole('button', { name: /auto-generate/i });
    expect(screen.queryByRole('status', { name: 'Auto-generate notes' })).toBeNull();
  });

  it('parseSkipped keeps only well-formed entries', () => {
    expect(parseSkipped({ data: { skipped: [{ transactionId: 'x', reason: 'r', action: 'flagged' }, { reason: 'no id' }, 7] } }))
      .toEqual([{ transactionId: 'x', action: 'flagged', reason: 'r' }]);
    expect(parseSkipped({ data: {} })).toEqual([]);
    expect(parseSkipped(null)).toEqual([]);
  });
});
