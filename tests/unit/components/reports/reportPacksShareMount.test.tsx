/**
 * The report-packs page is where the WS3 owner-side surfaces are reachable.
 *
 * Six modules — the share dialog, the commentary panel and everything under
 * them — were built with no production consumer. Code nothing mounts is code
 * nobody can be shown, and "it exists" is not the same claim as "a person can
 * use it". This suite is the difference: it renders the real page and asserts
 * a person can open the dialog, and that both surfaces are handed the pack the
 * page is actually showing.
 *
 * NOT covered, and not claimed anywhere: annotations. Nothing on this branch
 * owns an account-row page, so AnnotationThread and NoteMarker stay unmounted.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

let companyRole: string | null = 'owner';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import ReportPacksPage from '../../../../pages/accounting/reports/report-packs';

const PACK = {
  type: 'board',
  companyName: 'Brightsphere (Pty) Ltd',
  period: '2026-01-01 to 2026-09-06',
  generatedAt: '2026-09-06T00:00:00.000Z',
  sections: [{ type: 'income_statement', title: 'Income Statement', data: { revenue: 1 } }],
};

let fetchMock: ReturnType<typeof vi.fn>;

/** The page and the two mounted components all call the API. Answer each URL
 *  with the envelope its route promises, and remember every URL asked for. */
const asked: string[] = [];

beforeEach(() => {
  companyRole = 'owner';
  asked.length = 0;
  fetchMock = vi.fn(async (url: string) => {
    asked.push(String(url));
    const body = String(url).startsWith('/api/accounting/commentary')
      ? { commentary: [] }
      : String(url).startsWith('/api/accounting/share/links')
        ? { links: [] }
        : { pack: PACK, unclassifiedAccounts: null };
    return new Response(JSON.stringify({ success: true, data: body }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('report-packs page — WS3 surfaces are mounted', () => {
  it('opens the share dialog from the Share button', async () => {
    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getByText(/Brightsphere/)).toBeTruthy());

    expect(screen.queryByRole('dialog', { name: 'Share links' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Share/ }));

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Share links' })).toBeTruthy());
  });

  it('hands the dialog the pack the page is showing, not a default', async () => {
    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getByText(/Brightsphere/)).toBeTruthy());

    // Switch the pack type first: the params must follow the selector.
    fireEvent.click(screen.getByText('Monthly Pack'));
    await waitFor(() => expect(asked.some(u => u.includes('type=monthly'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Share links' })).toBeTruthy());

    const packCall = asked.find(u => u.includes('/api/accounting/reports-pack?type=monthly'))!;
    const period = new URL(packCall, 'https://x').searchParams;

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(c => String(c[0]) === '/api/accounting/share/links')).toBe(true));

    const [, init] = fetchMock.mock.calls.find(c => String(c[0]) === '/api/accounting/share/links')!;
    expect(JSON.parse(String((init as RequestInit).body)).params).toEqual({
      type: 'monthly', from: period.get('from'), to: period.get('to'),
    });
  });

  it('mounts the commentary panel against the same pack params', async () => {
    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy());

    const packCall = asked.find(u => u.includes('/api/accounting/reports-pack?'))!;
    const packQs = new URL(packCall, 'https://x').searchParams;
    const commentaryCall = asked.find(u => u.startsWith('/api/accounting/commentary?'))!;
    const cQs = new URL(commentaryCall, 'https://x').searchParams;

    expect(cQs.get('type')).toBe(packQs.get('type'));
    expect(cQs.get('from')).toBe(packQs.get('from'));
    expect(cQs.get('to')).toBe(packQs.get('to'));
  });

  it('shows no Share button to a role that cannot mint one', async () => {
    companyRole = 'manager';
    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getByText(/Brightsphere/)).toBeTruthy());

    expect(screen.queryByRole('button', { name: /Share/ })).toBeNull();
  });

  it('draws no commentary panel for a role the route would refuse', async () => {
    // The commentary GET arm is owner/admin/manager. Mounting the panel for a
    // viewer would put an error under the pack instead of simply not offering
    // commentary — and would fire a request that can only 403.
    companyRole = 'viewer';
    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getByText(/Brightsphere/)).toBeTruthy());

    expect(screen.queryByRole('button', { name: 'Regenerate' })).toBeNull();
    expect(asked.some(u => u.startsWith('/api/accounting/commentary'))).toBe(false);
  });

  it('draws it for a manager, who may read but not approve', async () => {
    companyRole = 'manager';
    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy());

    expect(asked.some(u => u.startsWith('/api/accounting/commentary'))).toBe(true);
  });
});