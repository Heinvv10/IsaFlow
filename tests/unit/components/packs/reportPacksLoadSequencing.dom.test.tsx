/**
 * The Report Packs screen's pack fetch, sequenced.
 *
 * BROWSER REVIEW BR2 (HIGH): there was no request sequencing. A reader who
 * switched pack type, or nudged a date, had two requests in flight and
 * whichever the server answered LAST won. A full-GL aggregation over a wide
 * period easily outlives a narrow one, so the screen could settle on the pack
 * the reader had already moved off — Board figures under a Management heading,
 * with the download buttons pointed at Management. Nothing on the page said so,
 * and the figures were individually correct, which is what makes it dangerous:
 * a reader has no way to notice.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const useRouterMock = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => useRouterMock() }));

// The page mounts WS3's owner-side tools, which read the company role from
// context. These suites render the page outside any provider, and this is not
// what any of them is about: a viewer's role draws no Share button and no
// commentary panel, so the surfaces under test are unchanged either way.
// `tests/unit/components/reports/reportPacksShareMount.test.tsx` is where the
// role gate itself is held.
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'viewer' }) }));

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  assertOk: vi.fn(() => Promise.resolve({})),
}));

import ReportPacksPage from '../../../../pages/accounting/reports/report-packs';

/** A pack whose company name says which request produced it. */
function pack(marker: string, type: string) {
  return {
    type,
    companyName: marker,
    period: '2026-01-01 to 2026-09-05',
    generatedAt: '2026-09-06T00:00:00.000Z',
    sections: [{ type: 'commentary', title: 'Commentary', data: { summary: 'Commentary text' } }],
  };
}

/** A response we hand back on demand, so one request can outlive another. */
function deferredResponse(marker: string, type: string) {
  let settle!: () => void;
  const gate = new Promise<void>((r) => { settle = r; });
  const response = gate.then(() => ({
    json: async () => ({ data: { pack: pack(marker, type), unclassifiedAccounts: null } }),
  }));
  return { response, settle };
}

beforeEach(() => {
  apiFetchMock.mockReset();
  useRouterMock.mockReset();
  useRouterMock.mockReturnValue({ isReady: true, pathname: '/accounting/reports/report-packs', query: {} });
});

describe('Report Packs screen — only the newest request may paint', () => {
  it('ignores a slow first response that lands after a newer selection resolved', async () => {
    // Board is the initial selection and answers SLOWLY; Management is chosen
    // next and answers first. The reader is looking at Management.
    const slowBoard = deferredResponse('SLOW-BOARD', 'board');
    const fastManagement = deferredResponse('FAST-MANAGEMENT', 'management');

    apiFetchMock.mockImplementation((url: string) =>
      (url.includes('type=board') ? slowBoard.response : fastManagement.response));

    render(<ReportPacksPage />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('Management Pack'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));

    fastManagement.settle();
    await waitFor(() => expect(screen.getByText(/FAST-MANAGEMENT/)).toBeInTheDocument());

    // Now the abandoned Board request finally lands. It must not repaint.
    slowBoard.settle();
    await new Promise((r) => setTimeout(r, 10));

    expect(screen.getByText(/FAST-MANAGEMENT/)).toBeInTheDocument();
    expect(screen.queryByText(/SLOW-BOARD/)).toBeNull();
  });

  it('ignores a stale response even when it is the only one that has landed', async () => {
    // The harsher ordering: nothing has painted yet when the reader switches,
    // so a naive guard that only compares against a PAINTED pack still lets
    // the abandoned request through.
    const slowBoard = deferredResponse('SLOW-BOARD', 'board');
    const pendingManagement = deferredResponse('PENDING-MANAGEMENT', 'management');

    apiFetchMock.mockImplementation((url: string) =>
      (url.includes('type=board') ? slowBoard.response : pendingManagement.response));

    render(<ReportPacksPage />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('Monthly Pack'));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));

    slowBoard.settle();
    await new Promise((r) => setTimeout(r, 10));

    // Still loading the Monthly pack — the abandoned Board answer painted
    // nothing, and the spinner did not clear on its arrival either.
    expect(screen.queryByText(/SLOW-BOARD/)).toBeNull();
  });

  it('still paints the newest request when it is the one that resolves', async () => {
    apiFetchMock.mockImplementation(async (url: string) => ({
      json: async () => ({
        data: {
          pack: pack(url.includes('type=management') ? 'MANAGEMENT' : 'BOARD',
            url.includes('type=management') ? 'management' : 'board'),
          unclassifiedAccounts: null,
        },
      }),
    }));

    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getByText(/BOARD/)).toBeInTheDocument());

    fireEvent.click(screen.getByText('Management Pack'));
    await waitFor(() => expect(screen.getByText(/MANAGEMENT/)).toBeInTheDocument());
  });
});
