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
  approvedBy: null, approvedAt: null,
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
  });
});
