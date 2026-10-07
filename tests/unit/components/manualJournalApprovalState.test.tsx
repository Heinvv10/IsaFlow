/**
 * R-035 PR6 (UI): the journal entry page shows a draft's DERIVED
 * manual-journal approval state (the detail GET's `approval`) through
 * DocumentApprovalPanel, noun "journal", and hides Post while the journal is
 * held (required, pending, stale) — the panel offers Submit.
 *
 * A Post that races into a 409 (a rule added, the content changed) — apiFetch
 * RESOLVES on a 4xx — reloads the entry into the state that offers Submit and
 * shows the refusal BESIDE the journal, not in place of it.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: { entryId: 'je-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { apiFetch } from '@/lib/apiFetch';
import JournalEntryDetailPage from '../../../pages/accounting/journal-entries/[entryId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

type State = 'not_required' | 'required' | 'pending' | 'approved' | 'stale';
const journal = (state: State, status = 'draft') => ({
  id: 'je-1', entryNumber: 'JE-0001', entryDate: '2026-09-01', source: 'manual', createdBy: 'u-1', status,
  description: 'Accrual', lines: [
    { id: 'l1', accountCode: '6000', accountName: 'Rent', debit: 1500, credit: 0 },
    { id: 'l2', accountCode: '1000', accountName: 'Bank', debit: 0, credit: 1500 },
  ],
  approval: status === 'draft'
    ? { state, enforced: state !== 'not_required', requiredRole: 'owner', ruleName: 'Journals sign',
      requestId: state === 'required' ? null : 'req-1' }
    : null,
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refused = (message: string, reason: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message, details: { reason } } }), { status: 409 });
const posts = () => fetchMock.mock.calls
  .filter(([, init]) => String((init as RequestInit | undefined)?.method) === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

/** Detail GETs answer from `docs` in turn (the last repeats); POSTs from `postAnswers`. */
function serve(docs: unknown[], postAnswers: Response[] = []) {
  let gets = 0;
  fetchMock.mockReset().mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return postAnswers.shift() ?? ok({});
    return ok(docs[Math.min(gets++, docs.length - 1)]);
  });
}
const postButton = () => screen.queryByRole('button', { name: /post entry/i });

describe('journal entry page — approval state', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it('required: says who must approve before it can be posted, offers Submit, hides Post', async () => {
    serve([journal('required')]);
    render(<JournalEntryDetailPage />);
    expect(await screen.findByText('This journal needs owner approval before it can be posted (rule: Journals sign).')).toBeDefined();
    expect(screen.queryByRole('button', { name: /submit for approval/i })).not.toBeNull();
    expect(postButton()).toBeNull();
  });

  it('Submit raises the request as manual_journal for this journal', async () => {
    serve([journal('required'), journal('pending')], [ok({ id: 'req-1' })]);
    render(<JournalEntryDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /submit for approval/i }));
    await waitFor(() => expect(posts()).toEqual([{
      url: '/api/accounting/approval-requests', body: { action: 'request', documentType: 'manual_journal', documentId: 'je-1' },
    }]));
    expect(await screen.findByText(/awaiting approval by an? owner/i)).toBeDefined();
    expect(postButton()).toBeNull();
  });

  it('approved or not required: offers Post; stale hides it', async () => {
    serve([journal('approved')]);
    const { unmount } = render(<JournalEntryDetailPage />);
    expect(await screen.findByText('Approved by an owner — ready to post.')).toBeDefined();
    expect(postButton()).not.toBeNull();
    unmount();
    serve([journal('not_required')]);
    const second = render(<JournalEntryDetailPage />);
    await waitFor(() => expect(postButton()).not.toBeNull());
    second.unmount();
    serve([journal('stale')]);
    render(<JournalEntryDetailPage />);
    expect(await screen.findByText(/this journal changed after it was approved/i)).toBeDefined();
    expect(postButton()).toBeNull();
  });

  it('a Post that races into a 409 shows the refusal beside the journal and, reloaded, offers Submit', async () => {
    const message = 'Manual journal JE-0001 needs owner approval before it can be posted (rule: Journals sign).';
    serve([journal('not_required'), journal('required')], [refused(message, 'APPROVAL_REQUIRED')]);
    render(<JournalEntryDetailPage />);
    await waitFor(() => expect(postButton()).not.toBeNull());
    fireEvent.click(postButton()!);
    expect(await screen.findByText(message)).toBeDefined();
    expect(await screen.findByRole('button', { name: /submit for approval/i })).toBeDefined();
    expect(screen.getByText('Journal Lines')).toBeDefined();
    expect(postButton()).toBeNull();
  });
});
