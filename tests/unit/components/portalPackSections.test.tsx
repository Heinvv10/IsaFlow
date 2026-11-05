// @vitest-environment happy-dom
// The client portal shows a management pack as the PDF and the app do: vocabulary titles, statement tables,
// a sentence for an empty section, no cover section, no AI failure sentence. An AFS document keeps its layout.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/lib/apiFetch', async () => ({ assertOk: vi.fn(), apiErrorMessage: vi.fn(() => '') }));
vi.mock('@/lib/auth/portalJwt', () => ({ verifyPortalToken: vi.fn() }));
vi.mock('@/lib/auth/portalAuth', () => ({ currentPortalSession: vi.fn() }));
vi.mock('next/head', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));

import PortalDocumentPage from '../../../pages/accounting/afs/portal/documents/[documentId]';

afterEach(cleanup);
const sec = (id: string, section_type: string, blocks: unknown[], ai_narrative: string | null = null) =>
  ({ id, section_type, sort_order: 0, status: 'ai_enhanced', content: { title: section_type, blocks }, ai_narrative });
const show = (document_type: string, sections: unknown[]) => {
  const props = { document: { id: 'd', fiscal_year: null, period: '2026-10', document_type, status: 'draft', signing_requested_at: null }, sections, canAnnotate: false } as unknown as Parameters<typeof PortalDocumentPage>[0];
  render(<PortalDocumentPage {...props} />);
};

describe('portal document page, management pack', () => {
  it('titles, tables, empty sections, narrative', () => {
    show('management_pack', [
      sec('1', 'cover', [], 'cover words'),
      sec('2', 'income_vs_budget', [{ type: 'table', headers: ['', 'Actual'], rows: [['Turnover', 'R 10.00'], ['Net profit', 'R 4.00']], rowKinds: ['line', 'total'] }], 'Sales held.'),
      sec('3', 'cash_flow', [], 'AI commentary unavailable for this section.'),
    ]);
    expect(screen.getAllByText('Income vs Budget').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Income Vs Budget/i, { selector: 'h2' })?.textContent).toBe('Income vs Budget');
    expect(screen.getByText('R 10.00')).toBeTruthy();
    expect(screen.getByText('Sales held.')).toBeTruthy();
    expect(screen.getByText('This section is not yet available in the management pack.')).toBeTruthy();
    expect(screen.queryByText('cover words')).toBeNull();
    expect(screen.queryByText(/AI commentary unavailable/)).toBeNull();
    expect(screen.queryByText('cash flow')).toBeNull();
  });

  it('a table with non-string cells and headers renders as text instead of crashing the page', () => {
    show('management_pack', [sec('1', 'kpi_scorecard', [{ type: 'table', headers: ['A', 5], rows: [['x', 42], ['y', null], ['z', { v: 1 }]] }])]);
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('an AFS document keeps its section_type headings and prints no table', () => {
    show('afs', [sec('1', 'statement_of_fp', [{ type: 'table', headers: ['A'], rows: [['cell']] }, { type: 'paragraph', text: 'words' }])]);
    expect(screen.getAllByText('statement of fp').length).toBeGreaterThan(0);
    expect(screen.getByText('words')).toBeTruthy();
    expect(screen.queryByText('cell')).toBeNull();
  });
});
