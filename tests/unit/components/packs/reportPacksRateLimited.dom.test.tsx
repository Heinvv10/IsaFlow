/**
 * The Report Packs screen when the server says 429.
 *
 * BROWSER REVIEW BR3 (MEDIUM): `apiFetch` RESOLVES on a 4xx, so a rate-limited
 * pack request fell through to `.json()`, produced an envelope with no `data`,
 * and left the screen blank — no spinner, no message, nothing to distinguish it
 * from a company with no ledger. The limit is per company and shared with every
 * other report route, so a reader who exported a few packs reaches it without
 * doing anything unusual.
 *
 * The limit itself is unchanged. This is about saying so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { retryAfterSeconds } from '../../../../pages/accounting/reports/report-packs';

const useRouterMock = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => useRouterMock() }));

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  assertOk: vi.fn(() => Promise.resolve({})),
}));

import ReportPacksPage from '../../../../pages/accounting/reports/report-packs';

const PACK = {
  type: 'board',
  companyName: 'Brightsphere',
  period: '2026-01-01 to 2026-09-05',
  generatedAt: '2026-09-06T00:00:00.000Z',
  sections: [{ type: 'commentary', title: 'Commentary', data: { summary: 'All good.' } }],
};

/** What apiFetch hands back — a Response-shaped object, resolved, 4xx and all. */
function response(status: number, headers: Record<string, string> = {}, body: unknown = {}) {
  return {
    status,
    ok: status < 400,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  useRouterMock.mockReset();
  useRouterMock.mockReturnValue({ isReady: true, pathname: '/accounting/reports/report-packs', query: {} });
});

describe('retryAfterSeconds', () => {
  it('reads a whole number of seconds', () => {
    expect(retryAfterSeconds({ get: () => '30' })).toBe(30);
    expect(retryAfterSeconds({ get: () => ' 45 ' })).toBe(45);
  });

  it('is null when the header is absent — the normal case today', () => {
    expect(retryAfterSeconds({ get: () => null })).toBeNull();
  });

  it('is null for anything that is not a positive whole number of seconds', () => {
    // Including the HTTP-date form, which this endpoint's fixed-window limiter
    // never sends and which is deliberately not parsed.
    for (const raw of ['', 'soon', '0', '-5', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
      expect(retryAfterSeconds({ get: () => raw }), raw).toBeNull();
    }
  });
});

describe('Report Packs screen — a rate-limited pack request', () => {
  it('says so instead of rendering a blank page', async () => {
    apiFetchMock.mockResolvedValue(response(429, {}, { success: false, error: { code: 'RATE_LIMITED' } }));

    render(<ReportPacksPage />);

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent(/Too many report requests/);
    expect(screen.getByRole('status')).toHaveTextContent(/try again in a moment/);
  });

  it('names the wait when the server sends a Retry-After', async () => {
    apiFetchMock.mockResolvedValue(response(429, { 'Retry-After': '42' }));

    render(<ReportPacksPage />);

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/try again in 42 seconds/));
  });

  it('never calls .json() on the refusal — the body is an error envelope, not a pack', async () => {
    const json = vi.fn(async () => ({}));
    apiFetchMock.mockResolvedValue({ ...response(429), json });

    render(<ReportPacksPage />);

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(json).not.toHaveBeenCalled();
  });

  it('clears the notice once a later request succeeds', async () => {
    apiFetchMock.mockResolvedValueOnce(response(429));
    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

    // The reader switches pack type; this one is allowed through.
    apiFetchMock.mockResolvedValue(response(200, {}, { data: { pack: PACK, unclassifiedAccounts: null } }));
    screen.getByText('Management Pack').click();

    await waitFor(() => expect(screen.getByText(/Brightsphere/)).toBeInTheDocument());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows no notice on an ordinary successful load', async () => {
    apiFetchMock.mockResolvedValue(response(200, {}, { data: { pack: PACK, unclassifiedAccounts: null } }));

    render(<ReportPacksPage />);

    await waitFor(() => expect(screen.getByText(/Brightsphere/)).toBeInTheDocument());
    expect(screen.queryByRole('status')).toBeNull();
  });
});
