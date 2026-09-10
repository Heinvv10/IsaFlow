/**
 * K-043 (review M2): the approvals page threw the 403 body away, so a
 * segregation-of-duties refusal read as "Failed to process decision" — the same
 * text a network failure produced. The reason the server sent has to reach the
 * screen, otherwise the whole control is invisible to the person it stops.
 *
 * Rendered, not grepped: the message travels through a catch and a state setter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import { apiFetch } from '@/lib/apiFetch';
import ApprovalsPage from '../../../pages/accounting/approvals/index';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

const pendingRequest = {
  id: 'req-1', documentType: 'supplier_invoice', documentId: 'doc-00000001',
  documentReference: 'INV-001', amount: 250000, status: 'pending',
  requestedByName: 'Thandi', requestedAt: '2026-09-01T00:00:00Z',
  decidedByName: undefined, decidedAt: null, decisionNotes: null,
};

const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ data }) });

/** The two loads the page issues on mount, then on every refetch. */
const primeLoad = () => {
  fetchMock.mockResolvedValueOnce(ok({ items: [pendingRequest] }));
  fetchMock.mockResolvedValueOnce(ok({ items: [] }));
};

describe('approvals page — decision refusal', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("shows the server's reason when the decision is refused", async () => {
    primeLoad();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You cannot approve an approval request you raised yourself',
          details: { reason: 'SELF_APPROVAL_FORBIDDEN' },
        },
      }),
    });

    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByText('Approve'));

    expect(await screen.findByText(
      'You cannot approve an approval request you raised yourself',
    )).toBeDefined();
    expect(screen.queryByText('Failed to process decision')).toBeNull();
  });

  it('falls back to the generic message when the body carries no reason', async () => {
    primeLoad();
    fetchMock.mockResolvedValueOnce({ ok: false, json: () => Promise.reject(new Error('not json')) });

    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByText('Approve'));

    expect(await screen.findByText('Failed to process decision')).toBeDefined();
  });

  it('clears a previous refusal and refetches when the decision succeeds', async () => {
    primeLoad();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'Refused once' } }),
    });

    render(<ApprovalsPage />);
    fireEvent.click(await screen.findByText('Approve'));
    expect(await screen.findByText('Refused once')).toBeDefined();

    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ data: {} }) });
    primeLoad();
    fireEvent.click(screen.getByText('Approve'));

    await waitFor(() => expect(screen.queryByText('Refused once')).toBeNull());
  });
});
