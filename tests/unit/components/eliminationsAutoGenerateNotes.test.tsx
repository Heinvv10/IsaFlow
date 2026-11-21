/**
 * Round 12: after Auto-Generate the Eliminations page lists the eliminations THIS run drafted with a flag (possibly the same sale as a
 * mirrored document), each with its reason; it never claims anything was left out. The notes belong to the group and period they were
 * generated for (cleared when either changes), and a committed generation always reloads even when the response body does not parse. A posted
 * adjustment whose row now matches a live mirror carries a warning in the list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import EliminationsPage from '@/../pages/accounting/group/eliminations';
import { parseFlagged } from '@/components/accounting/group/EliminationsFlaggedNotice';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const G1 = '80000000-0000-4000-8000-000000000001';
const G2 = '80000000-0000-4000-8000-000000000002';
const FLAGGED = [{ transactionId: 'bbbbbbbb-0000-4000-8000-000000000002', adjustmentId: 'a1', mirroredRef: 'Invoice ICAR-1 (mirrored)',
  reason: 'possibly the same sale as mirrored document Invoice ICAR-1 (mirrored) (same companies, direction, amount and date): posting it would eliminate the sale twice' }];

function serve(post: () => Response, items: unknown[] = []) {
  let lists = 0;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('company-groups')) return new Response(JSON.stringify({ success: true, data: [{ id: G1, name: 'Group 1' }, { id: G2, name: 'Group 2' }] }), { status: 200 });
    if (init?.method === 'POST') return post();
    lists += 1;
    return new Response(JSON.stringify({ success: true, data: { items } }), { status: 200 });
  });
  return { lists: () => lists };
}
const ok = (flagged: unknown) => () => new Response(JSON.stringify({ success: true, data: { items: [], count: 0, flagged } }), { status: 200 });
const notes = () => screen.queryByRole('status', { name: 'Auto-generate notes' });

describe('Auto-Generate shows the flagged drafts of this run', () => {
  it('one flagged draft: listed with its reason; Dismiss clears it', async () => {
    serve(ok(FLAGGED));
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-generate/i }));
    const n = await screen.findByRole('status', { name: 'Auto-generate notes' });
    expect(within(n).getByText(/1 elimination was drafted with a flag/)).toBeTruthy();
    expect(within(n).getByText(/same companies, direction, amount and date/)).toBeTruthy();
    expect(within(n).getByText('bbbbbbbb')).toBeTruthy();
    fireEvent.click(within(n).getByRole('button', { name: 'Dismiss' }));
    expect(notes()).toBeNull();
  });

  it('the notes are cleared when the group changes', async () => {
    serve(ok(FLAGGED));
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-generate/i }));
    await screen.findByRole('status', { name: 'Auto-generate notes' });
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: G2 } });
    await waitFor(() => expect(notes()).toBeNull());
  });

  it('a result that arrives after the group changed is dropped', async () => {
    let release!: (r: Response) => void;
    serve(() => { throw new Error('unused'); });
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('company-groups')) return new Response(JSON.stringify({ success: true, data: [{ id: G1, name: 'Group 1' }, { id: G2, name: 'Group 2' }] }), { status: 200 });
      if (init?.method === 'POST') return new Promise<Response>((r) => { release = r; });
      return new Response(JSON.stringify({ success: true, data: { items: [] } }), { status: 200 });
    });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-generate/i }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: G2 } });
    release(ok(FLAGGED)());
    await screen.findByRole('button', { name: /auto-generate/i });
    await new Promise((r) => setTimeout(r, 50));
    expect(notes()).toBeNull();
  });

  it('a 200 whose body does not parse: no error, no notes, and the list still reloads', async () => {
    const s = serve(() => new Response('not json', { status: 200 }));
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-generate/i }));
    const before = s.lists();
    await waitFor(() => expect(s.lists()).toBeGreaterThan(before - 1));
    await waitFor(() => expect(s.lists()).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/Could not generate/)).toBeNull();
    expect(notes()).toBeNull();
  });

  it('a posted adjustment whose row now matches a live mirror shows the warning in the list', async () => {
    serve(ok([]), [{ id: '7', groupId: G1, adjustmentNumber: 'ELIM-0007', adjustmentType: 'interco_revenue', description: 'manual sale', periodStart: '2026-01-01',
      periodEnd: '2026-01-31', status: 'posted', lines: [{ groupAccountId: 'x', debit: 1000, credit: 0 }, { groupAccountId: 'y', debit: 0, credit: 1000 }],
      sourceIntercompanyId: 's', mirroredDuplicateOf: 'Invoice ICAR-1 (mirrored)' }]);
    render(<EliminationsPage />);
    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(/same sale as mirrored document Invoice ICAR-1 \(mirrored\).*reverse this one/);
  });

  it('parseFlagged keeps only well-formed entries', () => {
    expect(parseFlagged({ data: { flagged: [{ transactionId: 'x', reason: 'r', adjustmentId: 'a', mirroredRef: 'm' }, { reason: 'no id' }, 7] } }))
      .toEqual([{ transactionId: 'x', adjustmentId: 'a', mirroredRef: 'm', reason: 'r' }]);
    expect(parseFlagged(null)).toEqual([]);
  });
});
