/**
 * R-035 PR6 (UI):
 *  - the Enforce switch lists manual journals by name, with the count of DRAFT
 *    journals it would hold, and switches that type;
 *  - active rules of the legacy `journal_entry` type govern no journal, so the
 *    manual-journal switch warns about them, and only it;
 *  - a request for a manual journal links to its page from Approvals > Pending.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { apiFetch } from '@/lib/apiFetch';
import { approvalDocumentHref } from '@/components/accounting/approvals/approvalDocumentHref';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ENFORCEABLE = ['supplier_invoice', 'customer_invoice', 'supplier_payment', 'payment_batch', 'manual_journal'];

function answer(legacyJournalRules: number) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST') return json({ success: true, data: {} });
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      return json({ data: {
        items: [], enforceable: ENFORCEABLE, legacyCreditNoteRules: 0, legacyPaymentRules: 0, legacyJournalRules,
        ...(path.includes('preview=1') ? { preview: { manual_journal: 3 } } : {}),
      } });
    }
    if (path.startsWith('/api/accounting/approval-requests')) {
      return json({ data: { items: [
        { id: '1', ruleName: 'Journals sign', documentType: 'manual_journal', documentId: 'je-9', documentReference: 'JE-0009',
          amount: 1500, documentDigest: 'a'.repeat(64), status: 'pending', requestedByName: 'Requester',
          requestedAt: '2026-10-07T08:00:00Z', decidedAt: null, decisionNotes: null },
      ] } });
    }
    return json({ data: { items: [] } });
  });
}

afterEach(() => { cleanup(); });

const openRules = async () => {
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /rules/i }));
};

describe('the Enforce switch', () => {
  it('lists manual journals with the drafts it would hold, and switches the type', async () => {
    answer(0);
    await openRules();
    const box = await screen.findByRole('checkbox', { name: /enforce manual journal approvals/i });
    expect(screen.getByText(/3 draft journals would need approval/i)).toBeDefined();
    fireEvent.click(box);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls
      .filter(([u, init]) => String(u).startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ documentType: 'manual_journal', enabled: true }]));
  });

  it('warns beside the manual-journal switch only, when legacy journal_entry rules are active', async () => {
    answer(1);
    await openRules();
    await screen.findByRole('checkbox', { name: /enforce manual journal approvals/i });
    expect(screen.getAllByText('1 legacy journal-entry rule governs nothing — re-create it as a manual journal rule'))
      .toHaveLength(1);
  });
});

describe('pending requests', () => {
  it('link a manual journal to its page, under its type label', async () => {
    answer(0);
    render(<ApprovalsPage />);
    expect((await screen.findByRole('link', { name: 'JE-0009' })).getAttribute('href')).toBe('/accounting/journal-entries/je-9');
    expect(screen.getByText('Manual Journal')).toBeDefined();
    expect(approvalDocumentHref('journal_entry', 'x')).toBeNull();
  });
});
