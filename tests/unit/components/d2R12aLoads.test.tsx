/**
 * D2 round 12 (findings of the round 8-10 review): afs document (stale-session period lookup, load success),
 * customer dedup scan, group dashboard failed load, document capture 2xx success:false, default accounts 403,
 * and the sales order whose confirm worked but whose reload failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoJargon, ok, on, refuse, serve, writeCalls } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/components/accounting/afs/AfsOverviewTab', () => ({ AfsOverviewTab: () => <p>TAB Overview</p> }));
vi.mock('@/components/accounting/afs/AfsNotesTab', () => ({ AfsNotesTab: () => null }));
vi.mock('@/components/accounting/afs/AfsStatementsTab', () => ({ AfsStatementsTab: () => null }));
vi.mock('@/components/accounting/afs/AfsReviewTab', () => ({ AfsReviewTab: () => null }));
vi.mock('@/components/accounting/afs/AfsExportTab', () => ({ AfsExportTab: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import AfsDocumentPage, { getServerSideProps } from '../../../pages/accounting/afs/[documentId]/index';
import DedupPage from '../../../pages/accounting/customers/dedup';
import GroupPage from '../../../pages/accounting/group/index';
import DocumentCapturePage from '../../../pages/accounting/document-capture/index';
import DefaultAccountsPage from '../../../pages/accounting/default-accounts/index';
import SalesOrderPage from '../../../pages/accounting/customer-sales-orders/[id]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); route.query = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('afs/[documentId] period lookup with a session the route will not accept', () => {
  type Ctx = Parameters<typeof getServerSideProps>[0];
  const ctx = () => ({ query: { documentId: 'doc-1' }, resolvedUrl: '/accounting/afs/doc-1', req: { headers: { host: 'app.test', cookie: 'c=1' } } }) as unknown as Ctx;
  const answer = (status: number) => vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })));
  it('401: sends the person to sign in and back, never to a period-error page that no reload can clear', async () => {
    answer(401);
    expect(await getServerSideProps(ctx())).toEqual({ redirect: { destination: '/login?returnTo=%2Faccounting%2Fafs%2Fdoc-1', permanent: false } });
  });
  it('403: the page renders (its own load explains the refusal), with no period error', async () => {
    answer(403);
    const r = await getServerSideProps(ctx()) as { props: { periodError: string | null } };
    expect(r.props.periodError).toBeNull();
  });
  it('404 is still not-found and a 500 still the period error page', async () => {
    answer(404); expect(await getServerSideProps(ctx())).toEqual({ notFound: true });
    answer(500); expect(((await getServerSideProps(ctx())) as { props: { periodError: string | null } }).props.periodError).toMatch(/Could not work out the reporting period/);
  });
});

describe('afs/[documentId] load', () => {
  const props = { documentId: 'doc-1', periodStart: '2026-03-01', periodEnd: '2026-03-31', periodError: null };
  it('success: the served document sets the heading, status and version', async () => {
    serve(on('GET', '/api/accounting/afs/doc-1', () => ok({ document: { id: 'doc-1', documentType: 'afs', fiscalYear: 2031, status: 'draft', version: 7, period: null } })));
    render(<AfsDocumentPage {...props} />);
    expect(await screen.findByText('AFS 2031')).toBeTruthy();
    expect(screen.getByText(/v7/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Submit for Review/ })).toBeTruthy();
  });
  it('an empty 500 shows one sentence and no document', async () => {
    serve(on('GET', '/api/accounting/afs/doc-1', empty500));
    render(<AfsDocumentPage {...props} />);
    expect(await screen.findByText('Could not load the document - try again')).toBeTruthy();
    expect(screen.queryByText(/AFS 2031/)).toBeNull(); expectNoJargon();
  });
});

describe('customers/dedup scan', () => {
  const pair = { id_a: 'a1', id_b: 'b1', name_a: 'D2 Alpha Traders', name_b: 'D2 Alpha Trading', email_a: 'x@d2.test', email_b: 'x@d2.test', vat_a: null, vat_b: null, match_reason: 'email', score: 1 };
  it('success: the scan lists the served pair', async () => {
    serve(on('GET', 'customer-duplicates', () => ok([pair])));
    render(<DedupPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /Scan for Duplicates/ })[0]!);
    expect(await screen.findByText(/D2 Alpha Traders/)).toBeTruthy();
    expect(screen.queryByText(/Could not scan/)).toBeNull();
  });
  it('failure: an empty 500 shows one sentence and no pairs', async () => {
    serve(on('GET', 'customer-duplicates', empty500));
    render(<DedupPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /Scan for Duplicates/ })[0]!);
    expect(await screen.findByText('Could not scan for duplicates - try again')).toBeTruthy();
    expect(screen.queryByText(/D2 Alpha Traders/)).toBeNull(); expectNoJargon();
  });
  it('failure: a refusal shows the server message', async () => {
    serve(on('GET', 'customer-duplicates', () => refuse()));
    render(<DedupPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /Scan for Duplicates/ })[0]!);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

describe('group dashboard when the groups cannot be loaded', () => {
  it('offers Retry, not Create Group; Retry reloads and shows the group', async () => {
    let fail = true;
    serve(on('GET', 'consolidated-reports', () => ok({ entitySummaries: [], eliminations: [], intercompanyBalances: [] })), (u, m) => (m === 'GET' && u.includes('company-groups') ? (fail ? empty500() : ok([{ id: 'g1', name: 'D2 Group One', memberCount: 1, holdingCompanyName: null }])) : undefined));
    render(<GroupPage />);
    expect(await screen.findByText('Could not load the company groups - try again')).toBeTruthy();
    expect(screen.queryByText(/Create Group/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findAllByText(/D2 Group One/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
  it('a company with no groups still offers Create Group', async () => {
    serve(on('GET', 'company-groups', () => ok([])));
    render(<GroupPage />);
    expect(await screen.findByText(/Create Group/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('document-capture list', () => {
  it('a 200 with success:false shows the server message, not the generic sentence', async () => {
    serve(on('GET', 'document-capture', () => new Response(JSON.stringify({ success: false, error: { message: MSG } }), { status: 200 })));
    render(<DocumentCapturePage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('Could not load documents - try again')).toBeNull();
  });
});

describe('default accounts load', () => {
  it('a 403 on the chart shows the server message', async () => {
    serve(on('GET', 'chart-of-accounts', () => refuse(MSG, 403)), on('GET', 'default-accounts', () => ok({ mappings: {} })));
    render(<DefaultAccountsPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty 500 keeps the one plain sentence', async () => {
    serve(on('GET', 'default-accounts', empty500));
    render(<DefaultAccountsPage />);
    expect(await screen.findByText('Could not load the default accounts - try again')).toBeTruthy(); expectNoJargon();
  });
});

describe('sales order: confirm worked, reload failed', () => {
  const order = (status: string) => ({ id: 'o1', orderNumber: 'D2-SO-001', customerName: 'D2 Customer', customerId: null, orderDate: '2026-09-01', deliveryDate: null,
    reference: null, status, subtotal: 1, taxAmount: 0, totalAmount: 1, notes: null, items: [] });
  const SENTENCE = 'The order was confirmed but could not be reloaded - refresh the page';
  it('says it was confirmed, never offers Confirm Order again, and posted once', async () => {
    route.query = { id: 'o1' };
    let gets = 0;
    serve(on('POST', 'customer-sales-orders-action', () => ok({})), (u, m) => (m === 'GET' && u.includes('customer-sales-orders') ? (++gets === 1 ? ok(order('draft')) : empty500()) : undefined));
    render(<SalesOrderPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm Order/ }));
    expect(await screen.findByText(SENTENCE)).toBeTruthy();
    expect(screen.queryByText(/Could not confirm the sales order/)).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Confirm Order/ })).toBeNull());
    expect(writeCalls('POST', 'customer-sales-orders-action')).toBe(1);
  });
});
