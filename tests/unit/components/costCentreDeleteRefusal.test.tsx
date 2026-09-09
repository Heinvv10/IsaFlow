/**
 * K-110 review round 2 (HIGH-1): the delete refusal must reach the operator.
 *
 * apiFetch RESOLVES on 4xx, so the page's try/catch never saw the 400 and the
 * empty catch swallowed the rest. Clicking Delete on an in-use cost centre
 * reloaded the list, left the row in place, and showed nothing at all — every
 * counted message the guard builds was unreachable from the product.
 *
 * Rendered, not grepped: only a real render proves the message is painted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => <button>Export CSV</button> }));

import CostCentresPage from '@/../pages/accounting/cost-centres/index';

const REFUSAL = 'Cannot delete cost centre that is used by 1 employee(s). Deactivate instead.';
const listBody = {
  data: { items: [{ id: 'cc-1', code: 'CC-001', name: 'Fleet', ccType: 'cc1', isActive: true }] },
};

function jsonResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

/** The real shape apiResponse.error() sends: the message is nested under `error`. */
function apiError(message: string) {
  return { success: false, error: { code: 'BAD_REQUEST', message }, meta: {} };
}

describe('cost centres page delete refusal', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('shows the counted refusal the API returned instead of a silent no-op', async () => {
    apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return jsonResponse(false, 400, apiError(REFUSAL));
      return jsonResponse(true, 200, listBody);
    });

    render(<CostCentresPage />);
    await screen.findByText('Fleet');
    fireEvent.click(screen.getByTitle('Delete'));

    await waitFor(() => expect(screen.getByText(REFUSAL)).toBeTruthy());
    // The row survives the refusal, and the operator now knows why.
    expect(screen.getByText('Fleet')).toBeTruthy();
  });

  it('surfaces a failed toggle rather than swallowing it', async () => {
    apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return jsonResponse(false, 400, apiError('Cost centre not found: cc-1'));
      return jsonResponse(true, 200, listBody);
    });

    render(<CostCentresPage />);
    await screen.findByText('Fleet');
    fireEvent.click(screen.getByTitle('Disable'));

    await waitFor(() => expect(screen.getByText('Cost centre not found: cc-1')).toBeTruthy());
  });

  it('reloads the list and shows no error when the delete succeeds', async () => {
    let deleted = false;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') { deleted = true; return jsonResponse(true, 200, { data: { deleted: true } }); }
      return jsonResponse(true, 200, deleted ? { data: { items: [] } } : listBody);
    });

    render(<CostCentresPage />);
    await screen.findByText('Fleet');
    fireEvent.click(screen.getByTitle('Delete'));

    await waitFor(() => expect(screen.queryByText('Fleet')).toBeNull());
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });

  it('reports a failed list load instead of rendering an empty table', async () => {
    apiFetch.mockResolvedValue(jsonResponse(false, 500, apiError('Database unavailable')));

    render(<CostCentresPage />);
    await waitFor(() => expect(screen.getByText('Database unavailable')).toBeTruthy());
  });
});
