// @vitest-environment happy-dom
// A management pack opens on /accounting/afs/<id> read-only, with its own sections in sortOrder;
// an AFS document keeps the AFS tabs and workflow actions.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children, href, className }: { children: React.ReactNode; href?: string; className?: string }) => <a href={href} className={className}>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn(async () => new Response('', { status: 500 })) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const tabMounts = vi.hoisted(() => vi.fn());
vi.mock('@/components/accounting/afs/AfsOverviewTab', () => ({ AfsOverviewTab: () => { tabMounts('overview'); return <p>TAB Overview</p>; } }));
vi.mock('@/components/accounting/afs/AfsNotesTab', () => ({ AfsNotesTab: () => <p>TAB Notes</p> }));
vi.mock('@/components/accounting/afs/AfsStatementsTab', () => ({ AfsStatementsTab: () => <p>TAB Statements</p> }));
vi.mock('@/components/accounting/afs/AfsReviewTab', () => ({ AfsReviewTab: () => <p>TAB Review</p> }));
vi.mock('@/components/accounting/afs/AfsExportTab', () => ({ AfsExportTab: () => <p>TAB Export</p> }));

import { apiFetch } from '@/lib/apiFetch';
import { managementPackTitle } from '@/components/accounting/afs/ManagementPackViewer';
import AfsDocumentPage from '../../../pages/accounting/afs/[documentId]/index';

afterEach(() => { cleanup(); tabMounts.mockClear(); });
const load = (document: object) => (apiFetch as unknown as ReturnType<typeof vi.fn>)
  .mockResolvedValueOnce(new Response(JSON.stringify({ data: { document } }), { status: 200 }));
const props = { documentId: 'p-1', periodStart: '2026-09-01', periodEnd: '2026-09-30', periodMonths: 1, periodError: null };
const sec = (sectionType: string, sortOrder: number, content: unknown, aiNarrative: string | null = null) =>
  ({ id: sectionType, sectionType, sortOrder, status: 'ai_enhanced', content, aiNarrative });

const pack = {
  id: 'p-1', documentType: 'management_pack', period: '2026-09', fiscalYear: null, status: 'draft', version: 1,
  sections: [
    sec('budget_variance', 5, { title: 'Budget Variance', blocks: [{ type: 'table', headers: ['Account', 'Actual'], rows: [['4100 Sales Revenue', 'R 120 000.00']] }] }),
    sec('cover', 0, { title: 'cover', blocks: [] }, 'Cover commentary'),
    sec('ai_executive_summary', 10, { title: 'ai_executive_summary', blocks: [] }, 'Summary text'),
  ],
};

describe('management pack on the AFS document page', () => {
  it('opens and lists its sections in print order, titled from the section vocabulary, without the cover section', async () => {
    load(pack);
    render(<AfsDocumentPage {...props} />);
    await screen.findByText('Budget Variance');
    const heads = screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent);
    expect(heads).toEqual(['AI Executive Summary', 'Budget Variance']);
    expect(screen.queryByText('Cover commentary')).toBeNull();
    expect(screen.getByText('4100 Sales Revenue')).toBeTruthy();
    expect(screen.getByText('Summary text')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Management Pack September 2026');
    expect(screen.queryByText('Annual Financial Statements')).toBeNull();
  });
  it('shows none of the AFS-only tabs or workflow actions', async () => {
    load(pack);
    render(<AfsDocumentPage {...props} />);
    await screen.findByText('Budget Variance');
    for (const t of ['Overview', 'Notes', 'Statements', 'Review', 'Compliance', 'Export']) expect(screen.queryByRole('button', { name: t })).toBeNull();
    expect(screen.queryByText(/Submit for Review/)).toBeNull();
    expect(screen.queryByText(/Sign Off/)).toBeNull();
    expect(screen.queryByText('TAB Overview')).toBeNull();
    expect(screen.getByText('Management Packs').closest('a')?.getAttribute('href')).toBe('/accounting/afs/management-packs');
  });
  it('an AFS document keeps its tabs and Submit for Review', async () => {
    load({ id: 'p-1', documentType: 'afs', fiscalYear: 2026, status: 'draft', version: 1, sections: [] });
    render(<AfsDocumentPage {...props} periodStart="2026-01-01" periodEnd="2026-12-31" periodMonths={12} />);
    await screen.findByText('Submit for Review');
    expect(screen.getByRole('button', { name: 'Statements' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Annual Financial Statements');
  });
  it('before the document loads: no AFS tab, no tab content, no action (and no tab fetch)', () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise(() => undefined));
    render(<AfsDocumentPage {...props} />);
    expect(screen.getByRole('status', { name: 'Loading document' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText('TAB Overview')).toBeNull();
    expect(tabMounts).not.toHaveBeenCalled();
  });
  it('a failed load shows the error and never the AFS tabs', async () => {
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('', { status: 500 }));
    render(<AfsDocumentPage {...props} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load the document/);
    expect(screen.queryByRole('button', { name: 'Overview' })).toBeNull();
    expect(tabMounts).not.toHaveBeenCalled();
  });
  it('an unknown block type and non-string cells render without throwing', async () => {
    load({ ...pack, sections: [sec('kpi_scorecard', 0, { title: 'KPI Scorecard', blocks: [
      { type: 'chart', text: 'fallback text' }, { type: 'mystery' },
      { type: 'table', headers: ['A', 'B'], rows: [['x', 42], ['y', { v: 1 }], ['z', null]] },
    ] })] });
    render(<AfsDocumentPage {...props} />);
    expect(await screen.findByText('fallback text')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });
  it('a section with nothing in it prints a sentence, an older pack\'s JSON statement prints as a table, an AI failure sentence is not shown', async () => {
    load({ ...pack, sections: [
      sec('cash_flow', 0, { title: 'cash_flow', blocks: [] }, 'AI commentary unavailable for this section.'),
      sec('balance_sheet', 1, { title: 'Balance Sheet', blocks: [{ type: 'paragraph', text: '{"currentAssets":44600,"totalEquity":44600}' }] }),
      sec('income_statement', 2, { title: 'Income Statement', blocks: [{ type: 'table', headers: ['', 'This month'], rows: [['Net profit', 'R 4.00']], rowKinds: ['total'] }] }),
    ] });
    render(<AfsDocumentPage {...props} />);
    await screen.findByText('Cash Flow');
    expect(screen.getByText('This section is not yet available in the management pack.')).toBeTruthy();
    expect(screen.queryByText(/AI commentary unavailable/)).toBeNull();
    expect(screen.getByText('Current assets')).toBeTruthy();
    expect(screen.queryByText(/currentAssets/)).toBeNull();
    expect(screen.getByText('Net profit').closest('tr')?.className).toContain('font-bold');
  });
  it('lists the sections in print order, not the stored sort_order, and survives an object title and a null block in overrides', async () => {
    const withOverrides = { ...sec('income_statement', 0, { title: 'Income Statement', blocks: [{ type: 'paragraph', text: 'generated' }] }), overrides: { title: { en: 'x' }, blocks: [null, { type: 'paragraph', text: 'accountant text' }] } };
    load({ ...pack, sections: [sec('balance_sheet', 0, { title: 'Balance Sheet', blocks: [] }), withOverrides, sec('kpi_scorecard', 2, { title: 'KPI Scorecard', blocks: [] })] });
    render(<AfsDocumentPage {...props} />);
    await screen.findByText('accountant text');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['KPI Scorecard', 'Income Statement', 'Balance Sheet']);
    expect(screen.queryByText('generated')).toBeNull();
  });
  it('the title names the pack month, not an AFS year', async () => {
    load(pack);
    render(<AfsDocumentPage {...props} />);
    await screen.findByText('Budget Variance');
    expect(managementPackTitle('2026-09')).toBe('Management Pack September 2026');
    expect(managementPackTitle(null)).toBe('Management Pack');
  });
});
