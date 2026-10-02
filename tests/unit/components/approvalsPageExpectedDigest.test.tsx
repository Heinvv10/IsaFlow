/**
 * R-035 re-check HIGH: approve now requires `expectedDigest` (400
 * EXPECTED_DIGEST_REQUIRED without it), and the approvals page sent only
 * `{ action, requestId }` — every supplier-invoice Approve in the UI failed.
 * The page must send the digest of the row the approver was looking at.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));

const DIGEST = 'a'.repeat(64);
const request = {
  id: 'req-1', ruleName: 'Owner over R50k', documentType: 'supplier_invoice', documentId: 'doc-1',
  documentReference: 'INV-R035', amount: 92500, documentDigest: DIGEST, status: 'pending',
  requestedByName: 'Requester', requestedAt: '2026-09-26T08:00:00Z', decidedByName: undefined,
  decidedAt: null, decisionNotes: null,
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

function answer() {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-requests') && init?.method === 'POST') return json({success: true, data: {}});
    if (path.startsWith('/api/accounting/approval-requests')) return json({data: {items: [request]}});
    return json({data: {items: []}});
  });
}

const postedBody = () => {
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST');
  return JSON.parse(String(call?.[1]?.body));
};

afterEach(() => { cleanup(); });

it('sends the row\'s documentDigest as expectedDigest when approving', async () => {
  answer();
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', {name: /approve/i}));
  await waitFor(() => expect(postedBody()).toEqual({action: 'approve', requestId: 'req-1', expectedDigest: DIGEST}));
});

it('sends no digest with a reject — only approve vouches for content', async () => {
  answer();
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', {name: /reject/i}));
  await waitFor(() => expect(postedBody()).toEqual({action: 'reject', requestId: 'req-1'}));
});
