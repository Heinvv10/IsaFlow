/**
 * D2 round 7 (k4): the AFS document page looks its reporting period up server-side. A failed lookup used to fall back
 * to the CURRENT year, so the page showed another period's statements without a word. Now: 404 -> not found, any other
 * failure (status or transport) -> an error page with no tabs; a good lookup is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, href, className }: { children: React.ReactNode; href?: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn(async () => new Response('', { status: 500 })) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/afs/AfsOverviewTab', () => ({ AfsOverviewTab: ({ periodMonths }: { periodMonths?: number | null }) => <p>TAB Overview months={String(periodMonths)}</p> }));
vi.mock('@/components/accounting/afs/AfsNotesTab', () => ({ AfsNotesTab: () => <p>TAB Notes</p> }));
vi.mock('@/components/accounting/afs/AfsStatementsTab', () => ({ AfsStatementsTab: () => <p>TAB Statements</p> }));
vi.mock('@/components/accounting/afs/AfsReviewTab', () => ({ AfsReviewTab: () => <p>TAB Review</p> }));
vi.mock('@/components/accounting/afs/AfsExportTab', () => ({ AfsExportTab: () => <p>TAB Export</p> }));

import { apiFetch } from '@/lib/apiFetch';
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
  it('the period length comes from the API; a period given in the query has no known length', async () => {
    stubFetch(() => new Response(JSON.stringify({ success: true, data: { periodStart: '2026-01-01', periodEnd: '2027-02-28', periodMonths: 14 } }), { status: 200 }));
    expect((await resolved()).props).toMatchObject({ periodMonths: 14 });
    expect((await resolved({ period_start: '2026-01-01', period_end: '2026-12-31' })).props).toMatchObject({ periodMonths: null });
    // Only one end given: the lookup still runs, but the length it answered no longer describes the page's period.
    expect((await resolved({ period_start: '2026-03-01' })).props).toMatchObject({ periodStart: '2026-03-01', periodMonths: null });
    stubFetch(() => new Response('', { status: 403 }));
    expect((await resolved()).props).toMatchObject({ periodMonths: null });
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
  it('a 403 states no period: empty, never a guessed calendar year', async () => {
    stubFetch(() => new Response('', { status: 403 }));
    expect((await resolved()).props).toMatchObject({ periodStart: '', periodEnd: '', periodError: null });
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
  it('with no period stated the page shows no period line and no period-bound tab', () => {
    render(<AfsDocumentPage documentId="doc-1" periodStart="" periodEnd="" periodError={null} />);
    expect(screen.queryByText(/Period:/)).toBeNull();
    expect(screen.queryByText(/TAB Overview/)).toBeNull();
  });
  it('an AFS document links to the report templates for its own period', async () => {
    const doc = { id: 'doc-1', documentType: 'afs', fiscalYear: 2026, status: 'draft', version: 1 };
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({ data: { document: doc } }), { status: 200 }));
    render(<AfsDocumentPage documentId="doc-1" periodStart="2026-01-01" periodEnd="2027-02-28" periodError={null} />);
    const link = await screen.findByText('Report templates for this period');
    expect(link.closest('a')?.getAttribute('href')).toBe('/accounting/afs/report-templates?document_id=doc-1');
  });
  // Measured in Chromium at 375 px against the compiled Tailwind CSS: the tab row (six non-wrapping buttons) made <main>
  // 717 px wide before (scrollWidth 717 vs clientWidth 375) and 375 after; the link was 3.36:1 on light (text-blue-500),
  // now 6.12:1 (text-blue-700; dark text-blue-400 5.75:1). jsdom has no layout, so these pin the classes that fixed it.
  it('the tab row scrolls inside its own container and the header row wraps, so the page never scrolls sideways', async () => {
    render(<AfsDocumentPage documentId="doc-1" periodStart="2023-03-01" periodEnd="2023-03-31" periodMonths={12} periodError={null} />);
    const tabRow = screen.getByText('Overview').closest('button')!.parentElement!;
    expect(tabRow.className).toContain('overflow-x-auto');
    expect(screen.getByText('Overview').closest('button')!.className).toMatch(/shrink-0.*whitespace-nowrap/);
    const header = screen.getByText('Annual Financial Statements').closest('div.max-w-6xl')!;
    expect(header.className).toContain('flex-wrap');
  });
  it('the report-templates link uses the accessible link colours (not blue-500)', async () => {
    const doc = { id: 'doc-1', documentType: 'afs', fiscalYear: 2026, status: 'draft', version: 1 };
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({ data: { document: doc } }), { status: 200 }));
    render(<AfsDocumentPage documentId="doc-1" periodStart="2023-03-01" periodEnd="2023-03-31" periodMonths={12} periodError={null} />);
    const cls = (await screen.findByText('Report templates for this period')).className;
    expect(cls).toContain('text-blue-700');
    expect(cls).toContain('dark:text-blue-400');
    expect(cls).not.toContain('text-blue-500');
  });
  it('the page hands the period length to the Overview tab', () => {
    render(<AfsDocumentPage documentId="doc-1" periodStart="2026-01-01" periodEnd="2027-02-28" periodMonths={14} periodError={null} />);
    expect(screen.getByText('TAB Overview months=14')).toBeTruthy();
  });
  it('the page shows the tabs when the period is known', () => {
    render(<AfsDocumentPage documentId="doc-1" periodStart="2023-03-01" periodEnd="2023-03-31" periodError={null} />);
    expect(screen.getByText(/TAB Overview/)).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Period: 2023-03-01 — 2023-03-31/)).toBeTruthy();
  });
});
