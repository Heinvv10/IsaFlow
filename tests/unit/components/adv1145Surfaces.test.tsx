// @vitest-environment happy-dom
// Adversarial repros for PR #1145: the in-app viewer and the client portal against the PDF.
// Every `it` asserts the CORRECT behaviour, so a red run is the finding.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => ({ assertOk: vi.fn(), apiErrorMessage: vi.fn(() => '') }));
vi.mock('@/lib/auth/portalJwt', () => ({ verifyPortalToken: vi.fn() }));
vi.mock('@/lib/auth/portalAuth', () => ({ currentPortalSession: vi.fn() }));

import { ManagementPackViewer } from '@/components/accounting/afs/ManagementPackViewer';
import { renderPackSectionContent } from '@/modules/accounting/services/afs/afsHtmlTableRenderer';
import PortalDocumentPage from '../../../pages/accounting/afs/portal/documents/[documentId]';
import type { AfsSection } from '@/modules/accounting/services/afs/afsTypes';

afterEach(cleanup);

const ORIGINAL = { title: 'Income Statement', blocks: [{ type: 'paragraph', text: 'ORIGINAL generated figure R 250 150.00' }] };
const OVERRIDES = { title: 'Income Statement (restated)', blocks: [{ type: 'paragraph', text: 'CORRECTED by the accountant R 250 000.00' }] };

describe('F2 the client portal ignores section overrides that the PDF, DOCX and in-app viewer print', () => {
  it('the PDF prints the override (control)', () => {
    const h = renderPackSectionContent({ id: 's1', sectionType: 'income_statement', content: ORIGINAL, overrides: OVERRIDES, aiNarrative: null } as unknown as AfsSection);
    expect(h).toContain('CORRECTED by the accountant');
    expect(h).not.toContain('ORIGINAL generated');
  });

  it('the portal shows the same override (even when handed it)', () => {
    const sections = [{ id: 's1', section_type: 'income_statement', sort_order: 0, status: 'ai_enhanced', content: ORIGINAL, overrides: OVERRIDES, ai_narrative: null }];
    const props = { document: { id: 'd', fiscal_year: null, period: '2026-10', document_type: 'management_pack', status: 'draft', signing_requested_at: null }, sections, canAnnotate: false } as unknown as Parameters<typeof PortalDocumentPage>[0];
    render(<PortalDocumentPage {...props} />);
    expect(screen.queryByText(/ORIGINAL generated/)).toBeNull();
    expect(screen.getByText(/CORRECTED by the accountant/)).toBeTruthy();
  });
});

describe('F1b an object overrides.title the route accepts crashes the in-app pack viewer', () => {
  it('renders', () => {
    const s = { id: 's1', sectionType: 'income_statement', sortOrder: 0, content: ORIGINAL, overrides: { title: { en: 'x' } }, aiNarrative: null } as unknown as AfsSection;
    expect(() => render(<ManagementPackViewer sections={[s]} />)).not.toThrow();
  });
});
