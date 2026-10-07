/**
 * `CommentaryPanel` — the container Task 11's presentational `CommentaryBlock`
 * needed: fetch on mount, approve/reject/refresh against the Task 10 routes,
 * and role gating so a non-approver never sees the buttons at all (the routes
 * enforce the same rule server-side; this is belt, not the buckle).
 *
 * `apiJson` resolves on 4xx and throws only via `assertOk` — a 403 must reach
 * the panel as an inline error, not a silently-empty row list, and the row
 * itself must be left exactly as it was (no optimistic mutation to undo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommentaryPanel } from '@/components/accounting/commentary/CommentaryPanel';
import type { CommentaryRow } from '@/modules/accounting/services/commentary/commentaryService';
import {
  MAX_APPROVED_PACK_EMS, approxCharsLeft, commentaryCost,
} from '@/modules/accounting/services/commentary/commentaryLimits';

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorEnvelope(status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PARAMS = { type: 'management' as const, from: '2026-08-01', to: '2026-08-31' };

const ROW: CommentaryRow = {
  id: 'row-1', sectionRef: 'income_statement', rowRef: 'revenue',
  draftText: 'DRAFT REVENUE SENTENCE', approvedText: null, status: 'draft',
  approvedBy: null, approvedAt: null, withdrawnBy: null, withdrawnAt: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CommentaryPanel', () => {
  it('loads rows for the section on mount', async () => {
    fetchMock.mockResolvedValue(envelope({ commentary: [ROW] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={PARAMS} />);

    await waitFor(() => expect(screen.getByText('DRAFT REVENUE SENTENCE')).toBeTruthy());

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/accounting/commentary?');
    expect(String(url)).toContain('type=management');
  });

  it('asks the route for the whole pack, not for one section', async () => {
    // The list route takes type, from and to and nothing else, so there is no
    // section to send. The hook used to accept a sectionRef and drop it on the
    // floor, which read as a filter that was never applied.
    const otherSection: CommentaryRow = {
      ...ROW, id: 'row-2', sectionRef: 'balance_sheet', rowRef: 'cash',
      draftText: 'DRAFT CASH SENTENCE',
    };
    fetchMock.mockResolvedValue(envelope({ commentary: [ROW, otherSection] }));

    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={PARAMS} />);
    await waitFor(() => expect(screen.getByText('DRAFT REVENUE SENTENCE')).toBeTruthy());

    // One request, carrying no section of any kind.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain('section');
    expect(url).not.toContain('income_statement');

    // The filtering happens in CommentaryBlock, on the rows already fetched:
    // the other section's sentence is in the response and not on the screen.
    expect(screen.queryByText('DRAFT CASH SENTENCE')).toBeNull();
  });

  it('says the response was wrong rather than rendering an empty section', async () => {
    // A 200 carrying the wrong arm of the route's union. Falling back to []
    // rendered as "no commentary yet", which invites somebody to regenerate
    // over sentences a named person had already approved.
    fetchMock.mockResolvedValue(envelope({ written: 3, skipped: [] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={PARAMS} />);

    await waitFor(() => expect(
      screen.getByText('The commentary response did not contain any commentary rows.')).toBeTruthy());
  });

  it('approves and refreshes when an approver clicks Approve', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ commentary: [ROW] })) // initial load
      .mockResolvedValueOnce(envelope({ commentary: { ...ROW, status: 'approved', approvedText: ROW.draftText } })) // approve
      .mockResolvedValueOnce(envelope({ commentary: [{ ...ROW, status: 'approved', approvedText: ROW.draftText }] })); // refresh

    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={PARAMS} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe('/api/accounting/commentary/row-1/approve');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('shows an inline error and leaves the row unchanged on a 403', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ commentary: [ROW] }))
      .mockResolvedValueOnce(errorEnvelope(403, 'Only an owner or admin can approve commentary.'));

    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={PARAMS} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(screen.getByText('Only an owner or admin can approve commentary.')).toBeTruthy());
    expect(screen.getByText('DRAFT REVENUE SENTENCE')).toBeTruthy();
    expect(screen.getByText('Draft — not published')).toBeTruthy();
  });

  it('renders no approve or reject buttons for a non-approver', async () => {
    fetchMock.mockResolvedValue(envelope({ commentary: [ROW] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove={false} params={PARAMS} />);

    await waitFor(() => expect(screen.getByText('DRAFT REVENUE SENTENCE')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('requires an explicit confirmation before generating with replace', async () => {
    fetchMock.mockResolvedValue(envelope({ commentary: [ROW] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={PARAMS} />);
    await waitFor(() => expect(screen.getByText('DRAFT REVENUE SENTENCE')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate' }));

    // The confirming checkbox must be unchecked by default — a plain click on
    // Regenerate must not silently withdraw an approval.
    const confirm = screen.getByRole('checkbox', { name: /overwrite approved commentary/i }) as HTMLInputElement;
    expect(confirm.checked).toBe(false);

    const generateButton = screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement;
    expect(generateButton.disabled).toBe(false);

    fireEvent.click(generateButton);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    const [, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ replace: false });

    fireEvent.click(confirm);
    expect(confirm.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    expect(JSON.parse((lastCall[1] as RequestInit).body as string)).toMatchObject({ replace: true });

    // A spent confirmation is spent: once the replace generate has completed,
    // the checkbox must reset, so a second Generate click cannot resend
    // `replace: true` on the strength of a tick the user gave once already.
    await waitFor(() => expect(confirm.checked).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4));
    const finalCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    expect(JSON.parse((finalCall[1] as RequestInit).body as string)).toMatchObject({ replace: false });
  });

  it('keeps the later params result when an earlier request resolves after it (stale-response guard)', async () => {
    const paramsA = { type: 'board' as const, from: '2026-08-01', to: '2026-08-31' };
    const paramsB = { type: 'management' as const, from: '2026-08-01', to: '2026-08-31' };
    const rowA: CommentaryRow = { ...ROW, id: 'row-a', draftText: 'ROW A TEXT — SLOW, STALE' };
    const rowB: CommentaryRow = { ...ROW, id: 'row-b', draftText: 'ROW B TEXT — FAST, CURRENT' };

    let resolveA!: (res: Response) => void;
    let resolveB!: (res: Response) => void;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('type=board')) return new Promise<Response>(res => { resolveA = res; });
      if (url.includes('type=management')) return new Promise<Response>(res => { resolveB = res; });
      throw new Error(`unexpected fetch: ${url}`);
    });

    const { rerender } = render(
      <CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={paramsA} />,
    );
    await waitFor(() => expect(resolveA).toBeDefined());

    // Params change (e.g. the caller flips the report period) before A's slow
    // request has returned — this fires a second, independent request for B.
    rerender(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={paramsB} />);
    await waitFor(() => expect(resolveB).toBeDefined());

    // B — the LATER request — resolves first.
    resolveB(envelope({ commentary: [rowB] }));
    await waitFor(() => expect(screen.getByText('ROW B TEXT — FAST, CURRENT')).toBeTruthy());

    // A — the EARLIER request — resolves late. Its stale result must never
    // overwrite B's, which is the one that actually matches current params.
    resolveA(envelope({ commentary: [rowA] }));
    await new Promise(r => setTimeout(r, 0));

    expect(screen.getByText('ROW B TEXT — FAST, CURRENT')).toBeTruthy();
    expect(screen.queryByText('ROW A TEXT — SLOW, STALE')).toBeNull();
  });
});

describe('CommentaryPanel approve with edits', () => {
  const BOARD = { type: 'board' as const, from: '2026-08-01', to: '2026-08-31' };
  const DRAFT = 'DRAFT REVENUE SENTENCE';
  /** The count the editor shows for `typed` in this row's place beside `others`' approved text (page order: others first). */
  const left = (others: string[], typed: string) =>
    `about ${approxCharsLeft(MAX_APPROVED_PACK_EMS - commentaryCost([...others, typed]))} characters left`;

  async function openEditor(rows: CommentaryRow[] = [ROW], params = BOARD) {
    fetchMock.mockResolvedValueOnce(envelope({ commentary: rows }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={params} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit: DRAFT REVENUE SENTENCE' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit: DRAFT REVENUE SENTENCE' }));
    return screen.getByRole('textbox', { name: /commentary text/i }) as HTMLTextAreaElement;
  }
  const typeInto = (box: HTMLTextAreaElement, value: string) => fireEvent.change(box, { target: { value } });

  it('opens a focused textarea prefilled with the machine draft, and a polite count of what is left', async () => {
    const box = await openEditor();
    expect(box.value).toBe(DRAFT);
    expect(document.activeElement).toBe(box);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(left([], DRAFT));
  });

  it('counts the trimmed text: padding with whitespace changes nothing', async () => {
    const box = await openEditor();
    const before = screen.getByRole('status').textContent;
    typeInto(box, `   ${DRAFT}  \n\n `);
    expect(screen.getByRole('status').textContent).toBe(before);
    typeInto(box, 'x'.repeat(50));
    typeInto(box, `  ${'x'.repeat(50)}  `);
    expect(screen.getByRole('status').textContent).toBe(left([], 'x'.repeat(50)));
  });

  it('counts what OTHER approved rows already spent, so the figure is the pack\u2019s, not the row\u2019s', async () => {
    const other: CommentaryRow = { ...ROW, id: 'row-2', rowRef: 'cogs', status: 'approved', approvedText: 'z'.repeat(499) };
    await openEditor([ROW, other]);
    expect(screen.getByRole('status').textContent).toBe(`about ${approxCharsLeft(MAX_APPROVED_PACK_EMS - commentaryCost([DRAFT, 'z'.repeat(499)]))} characters left`);
    // ...and the row is costed where the page prints it: before the other row, not after.
  });

  it('names every Edit button by the sentence the row shows, not by an internal key', async () => {
    const second: CommentaryRow = { ...ROW, id: 'row-2', rowRef: 'cogs', draftText: 'DRAFT COGS' };
    fetchMock.mockResolvedValueOnce(envelope({ commentary: [ROW, second] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={BOARD} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit: DRAFT REVENUE SENTENCE' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Edit: DRAFT COGS' })).toBeTruthy();
  });

  it('approves the edited text: POSTs exactly { text } with the padding trimmed, then refreshes', async () => {
    const box = await openEditor();
    typeInto(box, '  The CFO\u2019s own sentence.  \n');
    fetchMock
      .mockResolvedValueOnce(envelope({ commentary: { ...ROW, status: 'approved' } }))
      .mockResolvedValueOnce(envelope({ commentary: [{ ...ROW, status: 'approved', approvedText: 'The CFO\u2019s own sentence.' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve edited text' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe('/api/accounting/commentary/row-1/approve');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBe(JSON.stringify({ text: 'The CFO\u2019s own sentence.' }));
    await waitFor(() => expect(screen.getByText('The CFO\u2019s own sentence.')).toBeTruthy());
    expect(screen.queryByRole('textbox')).toBeNull();
    // Focus does not fall to <body>: it lands on the sentence that replaced the editor.
    expect(document.activeElement?.textContent).toBe('The CFO\u2019s own sentence.');
  });

  it('Cancel restores the draft row, sends nothing and returns focus to the Edit button', async () => {
    const box = await openEditor();
    typeInto(box, 'half-written');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(DRAFT)).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the initial load only
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit: DRAFT REVENUE SENTENCE' }));
    // Re-opening starts from the draft again, not from the abandoned edit.
    fireEvent.click(screen.getByRole('button', { name: 'Edit: DRAFT REVENUE SENTENCE' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(DRAFT);
  });

  it('will not submit text past the page limit, and says by about how much', async () => {
    const box = await openEditor();
    typeInto(box, 'x'.repeat(1500));
    expect(screen.getByRole('status').textContent).toMatch(/^over the page limit by about \d+ characters$/);
    const approve = screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('will not submit text with nothing but whitespace', async () => {
    const box = await openEditor();
    typeInto(box, '   \n ');
    expect((screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('accepts text that exactly fills the room', async () => {
    const box = await openEditor();
    let n = 0;
    while (commentaryCost(['x'.repeat(n + 1)]) <= MAX_APPROVED_PACK_EMS) n += 1;
    typeInto(box, 'x'.repeat(n));
    expect((screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement).disabled).toBe(false);
    typeInto(box, 'x'.repeat(n + 1));
    expect((screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows no count and no limit for a pack that prints on no fixed page', async () => {
    const box = await openEditor([ROW], PARAMS); // PARAMS is a management pack
    expect(screen.queryByRole('status')).toBeNull();
    typeInto(box, 'x'.repeat(1200));
    expect((screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('collapses newlines, tabs and runs of spaces in the Edit button name', async () => {
    const messy: CommentaryRow = { ...ROW, draftText: '  Revenue\ngrew\t\tby   25%.\n\n  Costs held.  ' };
    fetchMock.mockResolvedValueOnce(envelope({ commentary: [messy] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={BOARD} />);
    const button = await screen.findByRole('button', { name: /^Edit:/ });
    expect(button.getAttribute('aria-label')).toBe('Edit: Revenue grew by 25%. Costs held.');
  });

  it('a stale over-budget screen recovers: Refresh re-fetches, re-costs, and Approve is enabled again', async () => {
    const big: CommentaryRow = { ...ROW, id: 'row-big', rowRef: 'cogs', status: 'approved', approvedText: 'word '.repeat(250).trim() };
    const box = await openEditor([ROW, big]);
    typeInto(box, 'A sentence of reasonable length that no longer fits beside the big one.');
    const approve = () => screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement;
    expect(approve().disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(/^over the page limit/);
    // A peer withdrew the big approval: the server now returns it as a draft.
    fetchMock.mockResolvedValueOnce(envelope({ commentary: [ROW, { ...big, status: 'draft', approvedText: null }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(approve().disabled).toBe(false));
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
    // The typed text survived the refresh.
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('A sentence of reasonable length');
  });

  it('offers no Refresh for the character ceiling on a pack with no fixed page: a re-fetch cannot change it', async () => {
    const box = await openEditor([ROW], PARAMS);
    typeInto(box, 'x'.repeat(4001));
    expect(screen.getByRole('status').textContent).toBe('over the 4000-character limit');
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('offers no Refresh while the pack is not over budget', async () => {
    await openEditor();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('shortens a long sentence in the Edit button name', async () => {
    const long: CommentaryRow = { ...ROW, draftText: `${'Long sentence '.repeat(10)}end` };
    fetchMock.mockResolvedValueOnce(envelope({ commentary: [long] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={BOARD} />);
    const button = await screen.findByRole('button', { name: /^Edit: Long sentence/ });
    expect(button.getAttribute('aria-label')!.length).toBeLessThan(70);
    expect(button.getAttribute('aria-label')).not.toContain('revenue'); // the internal rowRef
  });

  it('applies the ceiling to a pack with no fixed page, and says so', async () => {
    const box = await openEditor([ROW], PARAMS);
    typeInto(box, 'x'.repeat(4000));
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement).disabled).toBe(false);
    typeInto(box, 'x'.repeat(4001));
    expect(screen.getByRole('status').textContent).toBe('over the 4000-character limit');
    expect((screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps the editor and the typed text when the server refuses, and shows why', async () => {
    const box = await openEditor();
    typeInto(box, 'My sentence.');
    fetchMock.mockResolvedValueOnce(errorEnvelope(400, 'That commentary is too long.'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve edited text' }));

    await waitFor(() => expect(screen.getByText('That commentary is too long.')).toBeTruthy());
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('My sentence.');
    expect((screen.getByRole('button', { name: 'Approve edited text' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('plain Approve still sends no body', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ commentary: [ROW] }))
      .mockResolvedValueOnce(envelope({ commentary: ROW }))
      .mockResolvedValueOnce(envelope({ commentary: [ROW] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove params={PARAMS} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBeUndefined();
  });

  it('shows no Edit button to a non-approver', async () => {
    fetchMock.mockResolvedValue(envelope({ commentary: [ROW] }));
    render(<CommentaryPanel sectionRef="income_statement" mode="internal" canApprove={false} params={PARAMS} />);
    await waitFor(() => expect(screen.getByText(DRAFT)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  });
});
