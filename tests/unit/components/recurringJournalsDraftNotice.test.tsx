/**
 * A draft-only recurring journal (migration 989, auto_post false) must not let a month slip out of the ledger
 * unnoticed: Generate leaves its journal a DRAFT while the schedule moves on, so the page says so and names the
 * journal, and the list marks such a template "Draft only". Rendered, not grepped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next/router', () => ({
  useRouter: () => ({ pathname: '/accounting/recurring-journals', isReady: true, query: {}, push: vi.fn(), events: { on: () => {}, off: () => {} } }),
}));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));

const base = { frequency: 'monthly', nextRunDate: '2026-11-15', runCount: 0, status: 'active', totalAmount: 500, lines: [] };
const DRAFT_ONLY = { ...base, id: '11111111-1111-4111-8111-111111111111', templateName: 'Cleaning accrual', autoPost: false };
const POSTS = { ...base, id: '22222222-2222-4222-8222-222222222222', templateName: 'Rent accrual', autoPost: true };

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

let actionResponse: Response;
const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes('recurring-journals-action')) return actionResponse.clone();
  if (String(url).includes('recurring-journals')) return ok({ items: [DRAFT_ONLY, POSTS] });
  return ok({ accounts: [] });
});

async function mountPage() {
  const { default: Page } = await import('../../../pages/accounting/recurring-journals/index');
  render(React.createElement(Page));
  await screen.findByText('Cleaning accrual');
}

describe('recurring journals page — a draft-only run is announced', () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('marks the draft-only template, and only it', async () => {
    await mountPage();
    expect(screen.getAllByText('Draft only')).toHaveLength(1);
    expect(screen.getByText('Cleaning accrual').closest('td')).toHaveTextContent('Draft only');
    expect(screen.getByText('Rent accrual').closest('td')).not.toHaveTextContent('Draft only');
  });

  it('says a generated journal was left a draft, naming it', async () => {
    actionResponse = ok({ journalId: 'je-1', entryNumber: 'JE-000042', posted: false, heldForApproval: [] });
    await mountPage();
    fireEvent.click(screen.getAllByTitle('Generate Now')[0]!);
    await waitFor(() => expect(screen.getByText(/Created as a DRAFT — post it from Journals: JE-000042/)).toBeInTheDocument());
  });

  it('says nothing when the journal posted, or when an older response carries no flag', async () => {
    actionResponse = ok({ journalId: 'je-2', entryNumber: 'JE-000043', posted: true, heldForApproval: [] });
    await mountPage();
    const button = screen.getAllByTitle('Generate Now')[1]!;
    fireEvent.click(button);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(screen.queryByText(/Created as a DRAFT/)).not.toBeInTheDocument();

    actionResponse = ok({ journalId: 'je-3' });
    fireEvent.click(button);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(screen.queryByText(/Created as a DRAFT/)).not.toBeInTheDocument();
  });

  it('a held journal is announced once, as held — not twice as a draft', async () => {
    actionResponse = ok({ journalId: 'je-4', entryNumber: 'JE-000044', posted: false, heldForApproval: ['je-4'] });
    await mountPage();
    fireEvent.click(screen.getAllByTitle('Generate Now')[1]!);
    await waitFor(() => expect(screen.getByText(/1 journal held for approval/)).toBeInTheDocument());
    expect(screen.queryByText(/Created as a DRAFT/)).not.toBeInTheDocument();
  });
});
