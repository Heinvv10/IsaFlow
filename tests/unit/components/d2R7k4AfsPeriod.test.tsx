/**
 * D2 round 7 (k4): the AFS document page looks its reporting period up server-side. A failed lookup used to fall back
 * to the CURRENT year, so the page showed another period's statements without a word. Now: 404 -> not found, any other
 * failure (status or transport) -> an error page with no tabs; a good lookup is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn(async () => new Response('', { status: 500 })) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/afs/AfsOverviewTab', () => ({ AfsOverviewTab: () => <p>TAB Overview</p> }));
vi.mock('@/components/accounting/afs/AfsNotesTab', () => ({ AfsNotesTab: () => <p>TAB Notes</p> }));
vi.mock('@/components/accounting/afs/AfsStatementsTab', () => ({ AfsStatementsTab: () => <p>TAB Statements</p> }));
vi.mock('@/components/accounting/afs/AfsReviewTab', () => ({ AfsReviewTab: () => <p>TAB Review</p> }));
vi.mock('@/components/accounting/afs/AfsExportTab', () => ({ AfsExportTab: () => <p>TAB Export</p> }));

import AfsDocumentPage, { getServerSideProps } from '../../../pages/accounting/afs/[documentId]/index';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
type Ctx = Parameters<typeof getServerSideProps>[0];
const ctx = (query: Record<string, string> = {}) => ({ query: { documentId: 'doc-1', ...query }, req: { headers: { host: 'app.test', cookie: 'c=1' } } }) as unknown as Ctx;
const stubFetch = (res: () => Response | Promise<Response>) => { const f = vi.fn(async () => res()); vi.stubGlobal('fetch', f); return f; };
const resolved = async (query?: Record<string, string>) => (await getServerSideProps(ctx(query))) as { props: { periodStart: string; periodEnd: string; periodError: string | null } };

describe('afs document period lookup', () => {
  it('a good lookup returns the document period and no error', async () => {
    stubFetch(() => new Response(JSON.stringify({ success: true, data: { periodStart: '2023-03-01', periodEnd: '2023-03-31' } }), { status: 200 }));
    expect((await resolved()).props).toMatchObject({ periodStart: '2023-03-01', periodEnd: '2023-03-31', periodError: null });
  });
  it('a 404 is not-found, not the current year', async () => {
    stubFetch(() => new Response('', { status: 404 }));
    expect(await getServerSideProps(ctx())).toEqual({ notFound: true });
  });
  it('a 500 or a transport failure carries an error and is not presented as a period', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    expect((await resolved()).props.periodError).toMatch(/Could not work out the reporting period/);
    stubFetch(() => { throw new TypeError('fetch failed'); });
    expect((await resolved()).props.periodError).toMatch(/Could not work out the reporting period/);
  });
  it('explicit period overrides skip the lookup', async () => {
    const f = stubFetch(() => new Response('', { status: 500 }));
    expect((await resolved({ period_start: '2022-01-01', period_end: '2022-12-31' })).props).toMatchObject({ periodStart: '2022-01-01', periodError: null });
    expect(f).not.toHaveBeenCalled();
  });
  it('the page shows the error instead of the tabs when the period is unknown', () => {
    render(<AfsDocumentPage documentId="doc-1" periodStart="2026-01-01" periodEnd="2026-12-31" periodError="Could not work out the reporting period for this document - reload the page to try again" />);
    expect(screen.getByRole('alert').textContent).toMatch(/Could not work out the reporting period/);
    expect(screen.queryByText(/TAB Overview/)).toBeNull();
  });
  it('the page shows the tabs when the period is known', () => {
    render(<AfsDocumentPage documentId="doc-1" periodStart="2023-03-01" periodEnd="2023-03-31" periodError={null} />);
    expect(screen.getByText(/TAB Overview/)).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });
});
