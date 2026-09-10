/**
 * R-059 round 11 — the supplier-statement page does not offer Rematch on a
 * statement already marked reconciled.
 *
 * Rematch re-measures the variance (round 10), so on a reconciled statement it
 * would overwrite the variance it was reconciled at. The route now refuses it
 * with 409; the page must not offer a button that can only fail. Rendered from
 * the real page component with the route's response; only AppLayout, the router
 * and apiFetch are stubbed.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, query: { id: 'recon-1' }, push: vi.fn() }),
}));

let status = 'reconciled';
const asked: { url: string; method: string }[] = [];
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async (url: string, init?: { method?: string }) => {
    asked.push({ url: String(url), method: init?.method ?? 'GET' });
    const data = {
      id: 'recon-1', supplierId: 's1', supplierName: 'Acme', statementDate: '2026-08-31',
      periodStart: null, periodEnd: null, supplierBalance: 300, isaflowBalance: 300, variance: 0,
      status, missingInIsaflowCount: 0, missingInStatementCount: 0, amountDiffCount: 0,
      lines: [], missingInvoices: [], createdAt: '2026-09-01T00:00:00Z', reconciledAt: null,
    };
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

import SupplierStatementPage from '../../../pages/accounting/ap/supplier-statements/[id]';

beforeEach(() => { asked.length = 0; });

describe('R-059 Rematch is closed on a reconciled statement', () => {
  it('reconciled: the Rematch button is disabled, and clicking it sends nothing', async () => {
    status = 'reconciled';
    render(<SupplierStatementPage />);
    const button = await screen.findByRole('button', { name: /rematch/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(asked.some(a => a.url.endsWith('/rematch'))).toBe(false);
  });

  it('unreconciled: Rematch is offered and posts to the route', async () => {
    status = 'unreconciled';
    render(<SupplierStatementPage />);
    const button = await screen.findByRole('button', { name: /rematch/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(asked.some(a => a.url.endsWith('/rematch') && a.method === 'POST')).toBe(true));
  });
});
