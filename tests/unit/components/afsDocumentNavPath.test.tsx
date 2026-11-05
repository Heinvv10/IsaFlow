/**
 * The AFS document page tells the layout which secondary-nav section it belongs to: a management pack (same URL as an
 * AFS document) passes navPath with ?type=management_pack; an AFS document passes none, so the router's path stands.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href?: string }) => <a href={href}>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: route.query, push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children, navPath }: { children: React.ReactNode; navPath?: string }) => <div data-testid="layout" data-nav-path={navPath ?? ''}>{children}</div>,
}));
vi.mock('@/components/accounting/afs/AfsDocumentTabs', () => ({ AfsDocumentTabs: () => <p>TABS</p> }));
vi.mock('@/components/accounting/afs/ManagementPackViewer', () => ({ ManagementPackView: () => <p>PACK VIEW</p>, managementPackTitle: () => 'Management pack' }));

import { apiFetch } from '@/lib/apiFetch';
import AfsDocumentPage from '../../../pages/accounting/afs/[documentId]/index';

afterEach(() => { cleanup(); route.query = {}; });
const load = (doc: Record<string, unknown>) => (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({ data: { document: doc } }), { status: 200 }));
const layout = () => screen.getByTestId('layout');

describe('AFS document page nav highlight', () => {
  it('a management pack asks for the Management Packs section', async () => {
    load({ id: 'ba60eeb5', documentType: 'management_pack', period: '2026-08', status: 'draft', version: 1 });
    render(<AfsDocumentPage documentId="ba60eeb5" periodStart="2026-08-01" periodEnd="2026-08-31" periodMonths={1} periodError={null} />);
    await screen.findByText('PACK VIEW');
    expect(layout().getAttribute('data-nav-path')).toBe('/accounting/afs/ba60eeb5?type=management_pack');
  });

  it('an AFS document passes no navPath, so the router path (AFS) stands', async () => {
    load({ id: 'a1', documentType: 'afs', fiscalYear: 2027, status: 'draft', version: 1 });
    render(<AfsDocumentPage documentId="a1" periodStart="2026-03-01" periodEnd="2027-02-28" periodMonths={12} periodError={null} />);
    await screen.findByText('TABS');
    expect(layout().getAttribute('data-nav-path')).toBe('');
  });

  it('a pack URL (?type=management_pack) claims Management Packs while the document loads, so a pack never flashes AFS', () => {
    route.query = { type: 'management_pack' };
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => undefined));
    render(<AfsDocumentPage documentId="ba60eeb5" periodStart="2026-08-01" periodEnd="2026-08-31" periodMonths={1} periodError={null} />);
    expect(layout().getAttribute('data-nav-path')).toBe('/accounting/afs/ba60eeb5?type=management_pack');
  });

  it('a pack URL also claims it on the load-error and period-error pages', async () => {
    route.query = { type: 'management_pack' };
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('', { status: 500 }));
    const { unmount } = render(<AfsDocumentPage documentId="ba60eeb5" periodStart="2026-08-01" periodEnd="2026-08-31" periodMonths={1} periodError={null} />);
    await screen.findByRole('alert');
    expect(layout().getAttribute('data-nav-path')).toBe('/accounting/afs/ba60eeb5?type=management_pack');
    unmount();
    render(<AfsDocumentPage documentId="ba60eeb5" periodStart="" periodEnd="" periodMonths={null} periodError="no period" />);
    expect(layout().getAttribute('data-nav-path')).toBe('/accounting/afs/ba60eeb5?type=management_pack');
  });

  it('the loaded document decides over the URL: an AFS document at a ?type=management_pack URL stays AFS', async () => {
    route.query = { type: 'management_pack' };
    load({ id: 'a1', documentType: 'afs', fiscalYear: 2027, status: 'draft', version: 1 });
    render(<AfsDocumentPage documentId="a1" periodStart="2026-03-01" periodEnd="2027-02-28" periodMonths={12} periodError={null} />);
    await screen.findByText('TABS');
    expect(layout().getAttribute('data-nav-path')).toBe('');
  });

  it('with no ?type in the URL, a document that is still loading claims no section', () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => undefined));
    render(<AfsDocumentPage documentId="a1" periodStart="2026-03-01" periodEnd="2027-02-28" periodMonths={12} periodError={null} />);
    expect(layout().getAttribute('data-nav-path')).toBe('');
  });
});
