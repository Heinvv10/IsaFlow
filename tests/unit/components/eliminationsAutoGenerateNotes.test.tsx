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

  const adj = (o: Record<string, unknown>) => ({ id: '7', groupId: G1, adjustmentNumber: 'ELIM-0007', adjustmentType: 'interco_revenue', description: 'manual sale',
    periodStart: '2026-01-01', periodEnd: '2026-01-31', status: 'posted', lines: [{ groupAccountId: 'x', debit: 1000, credit: 0 }, { groupAccountId: 'y', debit: 0, credit: 1000 }],
    sourceIntercompanyId: 's', mirroredDuplicateOf: 'Invoice ICAR-1 (mirrored)', ...o });

  it.each([
    ['posted, the mirror eliminated automatically', { status: 'posted', mirrorStands: true }, /Posted, and possibly the same sale as mirrored document Invoice ICAR-1 \(mirrored\).*reverse this one if so/],
    ['posted, the mirror NOT eliminated', { status: 'posted', mirrorStands: false }, /NOT eliminated automatically at the moment.*this may be its only elimination/],
    ['a draft, the mirror eliminated', { status: 'draft', mirrorStands: true }, /Possibly the same sale as mirrored document Invoice ICAR-1 \(mirrored\), which is eliminated automatically: check before posting/],
    ['a draft, the mirror NOT eliminated (a cut-off sale)', { status: 'draft', mirrorStands: false }, /NOT eliminated automatically at the moment.*this may be its only elimination/],
    ['two posted rows share the mirror', { status: 'posted', mirrorStands: true, mirrorShared: 2 }, /2 listed eliminations point at this mirror: at most one of them can be its duplicate\. Check which, and reverse that one only/],
  ])('%s: a "Possible duplicate" badge and the right advice', async (_n, o, text) => {
    serve(ok([]), [adj(o)]);
    render(<EliminationsPage />);
    const note = await screen.findByRole('note');
    expect(within(note).getByText('Possible duplicate')).toBeTruthy();
    expect(note.textContent).toMatch(text);
  });

  it('Post on a possible-duplicate draft asks first; Post anyway sends confirmDuplicate', async () => {
    const posts: unknown[] = [];
    serve(() => new Response(JSON.stringify({ success: true, data: { posted: true } }), { status: 200 }), [adj({ status: 'draft', mirrorStands: true, id: '70000000-0000-4000-8000-000000000007' })]);
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => { if (init?.method === 'POST') posts.push(JSON.parse(String(init.body))); return inner(url, init); });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^post$/i }));
    expect(await screen.findByText(/Post a possible duplicate\?/)).toBeTruthy();
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Post anyway' }));
    await waitFor(() => expect(posts).toEqual([{ action: 'post-elimination', adjustmentId: '70000000-0000-4000-8000-000000000007', confirmDuplicate: true }]));
  });

  it('a list response for a group no longer selected is dropped', async () => {
    let release!: (r: Response) => void;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('company-groups')) return new Response(JSON.stringify({ success: true, data: [{ id: G1, name: 'Group 1' }, { id: G2, name: 'Group 2' }] }), { status: 200 });
      if (String(url).includes(G1)) return new Promise<Response>((r) => { release = r; });
      return new Response(JSON.stringify({ success: true, data: { items: [] } }), { status: 200 });
    });
    render(<EliminationsPage />);
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: G2 } });
    await new Promise((r) => setTimeout(r, 20));
    release(new Response(JSON.stringify({ success: true, data: { items: [adj({ adjustmentNumber: 'ELIM-STALE' })] } }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('ELIM-STALE')).toBeNull();
  });

  it('parseFlagged keeps only well-formed entries', () => {
    expect(parseFlagged({ data: { flagged: [{ transactionId: 'x', reason: 'r', adjustmentId: 'a', mirroredRef: 'm' }, { reason: 'no id' }, 7] } }))
      .toEqual([{ transactionId: 'x', adjustmentId: 'a', mirroredRef: 'm', reason: 'r' }]);
    expect(parseFlagged(null)).toEqual([]);
  });
});
