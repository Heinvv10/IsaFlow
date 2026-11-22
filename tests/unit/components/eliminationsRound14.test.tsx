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
import { render, screen, cleanup, fireEvent, within, waitFor, act, configure } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import EliminationsPage from '@/../pages/accounting/group/eliminations';
import { mirrorFactsSentence, type MirrorFacts, type MirrorLinkState } from '@/modules/accounting/services/reports/mirrorFacts';
import { observedResponse } from '../helpers/observedResponse';

// the full page renders under a loaded gate: the siblings' 4 s async budget, never a longer testTimeout
configure({ asyncUtilTimeout: 4000 });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const G1 = '80000000-0000-4000-8000-000000000001';
const G2 = '80000000-0000-4000-8000-000000000002';
const ID = '70000000-0000-4000-8000-000000000007';
const groups = () => new Response(JSON.stringify({ success: true, data: [{ id: G1, name: 'Group 1' }, { id: G2, name: 'Group 2' }] }), { status: 200 });
/** The verified facts of one mirror (what the server sends as mirrorFacts). */
const one = (ref: string, stands: boolean, link: MirrorLinkState = 'none'): MirrorFacts => ({ label: ref, sum: false, periodEnd: '2026-01-31', mirrors: [{ ref, amount: 1000, stands, link }] });
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
          details: { reason: 'possible_duplicate', mirroredRef: 'Invoice ICAR-9 (mirrored)', mirrorFacts: one('Invoice ICAR-9 (mirrored)', true) } } }), { status: 409 }) });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^post$/i }));
    const dialog = await screen.findByText(/Post a possible duplicate\?/);
    expect(dialog).toBeTruthy();
    expect(screen.getByText(/Invoice ICAR-9 \(mirrored\), which is eliminated automatically and is not matched to any row yet\. If it is the same sale, posting this would eliminate it twice/)).toBeTruthy();
    expect(screen.queryByText('Possibly the same sale…')).toBeNull();   // (not shown as an error)
    fireEvent.click(screen.getByRole('button', { name: 'Post anyway' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: 'post-elimination', adjustmentId: ID, confirmDuplicate: true }));
  });

  it('a mirror that is NOT eliminated automatically: the dialog says so and never "eliminate the sale twice"', async () => {
    serve({ items: [draft({ mirroredDuplicateOf: 'Invoice ICAR-2 (mirrored)', mirrorFacts: one('Invoice ICAR-2 (mirrored)', false) })] });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^post$/i }));
    const msg = await screen.findByRole('dialog');
    expect(msg.textContent).toMatch(/Invoice ICAR-2 \(mirrored\), which is NOT eliminated automatically for the period to 2026-01-31/);
    expect(msg.textContent).toMatch(/this may be the sale's only elimination/);
    expect(msg.textContent).not.toMatch(/twice/);
    expect(within(msg).getByRole('button', { name: 'Post' })).toBeTruthy();
  });

  it('Auto-Generate lists the rows left to mirroring, by description, date and amount (never an id)', async () => {
    serve({ post: () => new Response(JSON.stringify({ success: true, data: { items: [], count: 0, flagged: [],
      skipped: [{ transactionId: 'cccccccc-0000-4000-8000-000000000003', reason: 'eliminated by mirroring (Invoice ICAR-3 (mirrored))', cutover: '2026-03-01', mirroredRef: 'Invoice ICAR-3 (mirrored)',
        detail: 'eliminated automatically on 2026-04-03, after the period to 2026-03-31, and is matched to this row',
        description: 'Manual sale March', date: '2026-03-05', amount: 1000 }] } }), { status: 200 }) });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /auto-generate/i }));
    const n = await screen.findByRole('status', { name: 'Auto-generate notes' });
    // (one heading, then each row with its mirror and what is true of that mirror for the period: R21 M2, the date it falls on)
    expect(n.textContent).toMatch(/1 intercompany row was not drafted: a mirrored document of the pair eliminates it\./);
    expect(n.textContent).toMatch(/2026-03-05 Manual sale March \(R\s?1[\s\u00a0]?000\.00\): mirrored document Invoice ICAR-3 \(mirrored\), which is eliminated automatically on 2026-04-03, after the period to 2026-03-31, and is matched to this row/);
    expect(n.textContent).not.toMatch(/not drafted: eliminated by mirroring/);   // (said for EVERY linked row before: the mirror's date can fall after the period)
    expect(n.textContent).not.toMatch(/cccccccc/);
  });

  it('from the cutover a manual elimination needs a reason: refused without one, sent with it', async () => {
    const posts = serve({ list: { reasonRequiredFrom: '2026-01-01' } });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /manual elimination/i }));
    const reason = await screen.findByLabelText(/Reason for a manual elimination/);
    // (what mirroring covers, said from the facts: a pair, ZAR, approved, mapped; never "this group's documents are eliminated by mirroring")
    expect(screen.getByText(/A company pair of this group mirrors its intercompany invoices and credit notes from 2026-01-01\. Mirroring eliminates only a ZAR document the receiver has approved/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Describe the elimination/), { target: { value: 'by hand' } });
    const codes = screen.getAllByPlaceholderText('e.g. 4000');
    codes.forEach((c) => fireEvent.change(c, { target: { value: '4000' } }));
    const amounts = screen.getAllByRole('spinbutton');
    fireEvent.change(amounts[0]!, { target: { value: '10' } });
    fireEvent.change(amounts[3]!, { target: { value: '10' } });
    fireEvent.submit(reason.closest('form')!);
    expect(await screen.findByText(/dated on or after 2026-01-01 needs a reason: give one/)).toBeTruthy();
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
    const failed = observedResponse(JSON.stringify({ success: false, error: { message: 'G1 load failed' } }), { status: 500 });
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('company-groups')) return groups();
      if (String(url).includes(G1)) return new Promise<Response>((r) => { fail = () => r(failed.res); });
      return new Response(JSON.stringify({ success: true, data: { items: [draft({ groupId: G2, adjustmentNumber: 'ELIM-G2' })] } }), { status: 200 });
    });
    render(<EliminationsPage />);
    await waitFor(() => expect(fail).toBeTypeOf('function'));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: G2 } });
    await screen.findByText('ELIM-G2');
    fail();
    await failed.read;                      // (the page read the stale answer: now nothing it does with it may show)
    await act(async () => {});
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
    await waitFor(() => expect(screen.queryByPlaceholderText(/Describe the elimination/)).toBeNull());   // (the create's answer handled)
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

  it('a failed reload (the same group, another period) clears the cutover: no reason field from a list that did not load', async () => {
    let fail = false;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('company-groups')) return groups();
      if (fail) return new Response(JSON.stringify({ success: false, error: { message: 'reload failed' } }), { status: 500 });
      return new Response(JSON.stringify({ success: true, data: { items: [], reasonRequiredFrom: '2026-01-01' } }), { status: 200 });
    });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /manual elimination/i }));
    expect(await screen.findByLabelText(/Reason for a manual elimination/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fail = true;
    fireEvent.change(screen.getByLabelText(/Period end/i), { target: { value: '31 Dec 2026' } });
    fireEvent.blur(screen.getByLabelText(/Period end/i));
    await screen.findByText(/reload failed/);
    fireEvent.click(screen.getByRole('button', { name: /manual elimination/i }));
    await screen.findByPlaceholderText(/Describe the elimination/);
    expect(screen.queryByLabelText(/Reason for a manual elimination/)).toBeNull();
  });

  it('switching group drops the previous group\'s cutover at once (while the new list is still loading)', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (String(url).includes('company-groups')) return groups();
      if (String(url).includes(G2)) return new Promise<Response>(() => undefined);   // (never answers)
      return new Response(JSON.stringify({ success: true, data: { items: [], reasonRequiredFrom: '2026-01-01' } }), { status: 200 });
    });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /manual elimination/i }));
    expect(await screen.findByLabelText(/Reason for a manual elimination/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: G2 } });
    fireEvent.click(screen.getByRole('button', { name: /manual elimination/i }));
    await screen.findByPlaceholderText(/Describe the elimination/);
    expect(screen.queryByLabelText(/Reason for a manual elimination/)).toBeNull();
  });

  it('a post-cutover draft whose mirror stands and is linked to another row: the badge and the dialog say (in one shared wording) the mirror was matched to a different row, and the button is a plain Post', async () => {
    const f = one('Invoice ICAR-5 (mirrored)', true, 'elsewhere');
    serve({ items: [draft({ mirroredDuplicateOf: 'Invoice ICAR-5 (mirrored)', mirrorFacts: f, pairCutover: '2026-03-01' })] });
    render(<EliminationsPage />);
    const shared = mirrorFactsSentence(f, '2026-03-01');
    expect(shared).toBe('Possibly the same sale as mirrored document Invoice ICAR-5 (mirrored), which is eliminated automatically, but is matched to a different row (the pair mirrors from 2026-03-01). If it is the same sale, posting this would eliminate it twice.');
    expect((await screen.findByRole('note')).textContent).toContain(`${shared} Check before posting.`);
    fireEvent.click(screen.getByRole('button', { name: /^post$/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(`${shared} Confirm to post it.`);
    expect(within(dialog).getByRole('button', { name: 'Post' })).toBeTruthy();
  });

  it('round 18: a post-cutover draft whose standing mirror NO row holds: "not matched to any row yet", never "matched to a different row"', async () => {
    const f = one('Invoice ICAR-5 (mirrored)', true, 'none');
    serve({ items: [draft({ mirroredDuplicateOf: 'Invoice ICAR-5 (mirrored)', mirrorFacts: f, pairCutover: '2026-03-01' })] });
    render(<EliminationsPage />);
    const shared = mirrorFactsSentence(f, '2026-03-01');
    expect(shared).toBe('Possibly the same sale as mirrored document Invoice ICAR-5 (mirrored), which is eliminated automatically and is not matched to any row yet (the pair mirrors from 2026-03-01). If it is the same sale, posting this would eliminate it twice.');
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain(`${shared} Check before posting.`);
    expect(note.textContent).not.toMatch(/matched to a different row/);
    fireEvent.click(screen.getByRole('button', { name: /^post$/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(`${shared} Confirm to post it.`);
    expect(dialog.textContent).not.toMatch(/matched to a different row/);
  });
});
