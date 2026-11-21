/**
 * Round 14 on the Eliminations page:
 *  - a stale list (the mirror accepted after it loaded): Post gets the 409 possible-duplicate and opens the confirm with the server's finding;
 *  - the dialog says what is true: "NOT eliminated automatically" for a mirror that is not (never "eliminate the sale twice");
 *  - Auto-Generate lists the rows left to mirroring ("eliminated by mirroring", RULING 2026-11-21);
 *  - from the group's mirroring cutover a manual elimination needs a reason (the dialog refuses to send without one, and sends it);
 *  - mirrored eliminations the period could not apply (an unmapped account) are shown;
 *  - a stale FAILED list load does not overwrite the current scope's list or error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import EliminationsPage from '@/../pages/accounting/group/eliminations';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const G1 = '80000000-0000-4000-8000-000000000001';
const G2 = '80000000-0000-4000-8000-000000000002';
const ID = '70000000-0000-4000-8000-000000000007';
const groups = () => new Response(JSON.stringify({ success: true, data: [{ id: G1, name: 'Group 1' }, { id: G2, name: 'Group 2' }] }), { status: 200 });
const draft = (o: Record<string, unknown> = {}) => ({ id: ID, groupId: G1, adjustmentNumber: 'ELIM-0007', adjustmentType: 'interco_revenue', description: 'manual sale',
  periodStart: '2026-01-01', periodEnd: '2026-01-31', status: 'draft', lines: [], sourceIntercompanyId: 's', ...o });

function serve(opts: { items?: unknown[]; list?: Record<string, unknown>; post?: (body: Record<string, unknown>) => Response }) {
  const posts: Array<Record<string, unknown>> = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).includes('company-groups?action=accounts')) {
      return new Response(JSON.stringify({ success: true, data: { items: [{ id: 'ga1', accountCode: '4000' }] } }), { status: 200 });
    }
    if (String(url).includes('company-groups')) return groups();
    if (init?.method === 'POST') { const b = JSON.parse(String(init.body)); posts.push(b); return opts.post ? opts.post(b) : new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }); }
    return new Response(JSON.stringify({ success: true, data: { items: opts.items ?? [], ...(opts.list ?? {}) } }), { status: 200 });
  });
  return posts;
}

describe('round 14: the Eliminations page', () => {
  it('a stale list: Post gets the 409 possible duplicate and opens the confirm with what the server found; confirming sends confirmDuplicate', async () => {
    const posts = serve({ items: [draft()], post: (b) => b.confirmDuplicate ? new Response(JSON.stringify({ success: true, data: { posted: true } }), { status: 200 })
      : new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message: 'Possibly the same sale…',
          details: { reason: 'possible_duplicate', mirroredRef: 'Invoice ICAR-9 (mirrored)', mirrorStands: true } } }), { status: 409 }) });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^post$/i }));
    const dialog = await screen.findByText(/Post a possible duplicate\?/);
    expect(dialog).toBeTruthy();
    expect(screen.getByText(/Invoice ICAR-9 \(mirrored\), which is eliminated automatically: posting this would eliminate the sale twice/)).toBeTruthy();
    expect(screen.queryByText('Possibly the same sale…')).toBeNull();   // (not shown as an error)
    fireEvent.click(screen.getByRole('button', { name: 'Post anyway' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: 'post-elimination', adjustmentId: ID, confirmDuplicate: true }));
  });

  it('a mirror that is NOT eliminated automatically: the dialog says so and never "eliminate the sale twice"', async () => {
    serve({ items: [draft({ mirroredDuplicateOf: 'Invoice ICAR-2 (mirrored)', mirrorStands: false })] });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^post$/i }));
    const msg = await screen.findByRole('dialog');
    expect(msg.textContent).toMatch(/Invoice ICAR-2 \(mirrored\), which is NOT eliminated automatically at the moment/);
    expect(msg.textContent).toMatch(/this may be the sale's only elimination/);
    expect(msg.textContent).not.toMatch(/eliminate the sale twice\. Confirm to post it anyway/);
    expect(within(msg).getByRole('button', { name: 'Post' })).toBeTruthy();
  });

  it('Auto-Generate lists the rows left to mirroring, by description, date and amount (never an id)', async () => {
    serve({ post: () => new Response(JSON.stringify({ success: true, data: { items: [], count: 0, flagged: [],
      skipped: [{ transactionId: 'cccccccc-0000-4000-8000-000000000003', reason: 'eliminated by mirroring (Invoice ICAR-3 (mirrored))', cutover: '2026-03-01',
        description: 'Manual sale March', date: '2026-03-05', amount: 1000 }] } }), { status: 200 }) });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-generate/i }));
    const n = await screen.findByRole('status', { name: 'Auto-generate notes' });
    expect(n.textContent).toMatch(/1 intercompany row was not drafted: a mirrored document eliminates each of them \(the pair mirrors from 2026-03-01\)/);
    expect(n.textContent).toMatch(/2026-03-05 Manual sale March \(R\s?1[\s\u00a0]?000\.00\): eliminated by mirroring \(Invoice ICAR-3 \(mirrored\)\)/);
    expect(n.textContent).not.toMatch(/cccccccc/);
  });

  it('from the cutover a manual elimination needs a reason: refused without one, sent with it', async () => {
    const posts = serve({ list: { reasonRequiredFrom: '2026-01-01' } });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /manual elimination/i }));
    const reason = await screen.findByLabelText(/Reason for a manual elimination/);
    fireEvent.change(screen.getByPlaceholderText(/Describe the elimination/), { target: { value: 'by hand' } });
    const codes = screen.getAllByPlaceholderText('e.g. 4000');
    codes.forEach((c) => fireEvent.change(c, { target: { value: '4000' } }));
    const amounts = screen.getAllByRole('spinbutton');
    fireEvent.change(amounts[0]!, { target: { value: '10' } });
    fireEvent.change(amounts[3]!, { target: { value: '10' } });
    fireEvent.submit(reason.closest('form')!);
    expect(await screen.findByText(/eliminated by mirroring from 2026-01-01: give a reason/)).toBeTruthy();
    expect(posts).toEqual([]);
    fireEvent.change(reason, { target: { value: 'fee booked as a journal' } });
    fireEvent.submit(reason.closest('form')!);
    await waitFor(() => expect(posts[0]).toEqual(expect.objectContaining({ action: 'create-elimination', manualReason: 'fee booked as a journal' })));
  });

  it('before any cutover there is no reason field', async () => {
    serve({ list: { reasonRequiredFrom: null } });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /manual elimination/i }));
    await screen.findByPlaceholderText(/Describe the elimination/);
    expect(screen.queryByLabelText(/Reason for a manual elimination/)).toBeNull();
  });

  it('mirrored eliminations the period could not apply are shown', async () => {
    serve({ list: { droppedMirrored: [{ transactionId: 't1', keyDate: '2026-01-15', description: 'Automatic: mirrored intercompany documents - Invoice X', amount: 1000 }] } });
    render(<EliminationsPage />);
    const a = await screen.findByRole('alert');
    expect(a.textContent).toMatch(/1 mirrored elimination not applied: an account has no group account mapped/);
    expect(a.textContent).toMatch(/2026-01-15: Automatic: mirrored intercompany documents - Invoice X/);
  });

  it('a stale FAILED load (a group no longer selected) neither clears the current list nor shows its error', async () => {
    let fail!: () => void;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('company-groups')) return groups();
      if (String(url).includes(G1)) return new Promise<Response>((r) => { fail = () => r(new Response(JSON.stringify({ success: false, error: { message: 'G1 load failed' } }), { status: 500 })); });
      return new Response(JSON.stringify({ success: true, data: { items: [draft({ groupId: G2, adjustmentNumber: 'ELIM-G2' })] } }), { status: 200 });
    });
    render(<EliminationsPage />);
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: G2 } });
    await screen.findByText('ELIM-G2');
    fail();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('G1 load failed')).toBeNull();
    expect(screen.getByText('ELIM-G2')).toBeTruthy();
  });

  it('a double submit (two submits in one batch) sends ONE create-elimination', async () => {
    const posts = serve({ list: { reasonRequiredFrom: null } });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /manual elimination/i }));
    const desc = await screen.findByPlaceholderText(/Describe the elimination/);
    fireEvent.change(desc, { target: { value: 'by hand' } });
    screen.getAllByPlaceholderText('e.g. 4000').forEach((c) => fireEvent.change(c, { target: { value: '4000' } }));
    const amounts = screen.getAllByRole('spinbutton');
    fireEvent.change(amounts[0]!, { target: { value: '10' } });
    fireEvent.change(amounts[3]!, { target: { value: '10' } });
    const form = desc.closest('form')!;
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts.filter((p) => p.action === 'create-elimination')).toHaveLength(1);
  });

  it('a 409 that is NOT a possible duplicate is shown as an error, no dialog', async () => {
    serve({ items: [draft()], post: () => new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT',
      message: 'This elimination is not a draft adjustment of this group (missing, another group\'s, or already posted).' } }), { status: 409 }) });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^post$/i }));
    expect(await screen.findByText(/This elimination is not a draft adjustment of this group/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the cutover of the previously loaded group is cleared on a group switch whose load fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('company-groups')) return groups();
      if (String(url).includes(G2)) return new Response(JSON.stringify({ success: false, error: { message: 'G2 failed' } }), { status: 500 });
      return new Response(JSON.stringify({ success: true, data: { items: [], reasonRequiredFrom: '2026-01-01' } }), { status: 200 });
    });
    render(<EliminationsPage />);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some((c) => String(c[0]).includes('eliminations'))).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: G2 } });
    await screen.findByText(/G2 failed/);
    fireEvent.click(screen.getByRole('button', { name: /manual elimination/i }));
    await screen.findByPlaceholderText(/Describe the elimination/);
    expect(screen.queryByLabelText(/Reason for a manual elimination/)).toBeNull();
  });
});
