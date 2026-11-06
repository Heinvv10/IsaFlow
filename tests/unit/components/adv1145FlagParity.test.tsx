// @vitest-environment happy-dom
// Adversarial (PR #1145 fix 3): the accepted-narrative flag on all four surfaces, and the paths that change ai_narrative after accept.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import JSZip from 'jszip';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => ({ assertOk: vi.fn(), apiErrorMessage: vi.fn(() => '') }));
vi.mock('@/lib/auth/portalJwt', () => ({ verifyPortalToken: vi.fn() }));
vi.mock('@/lib/auth/portalAuth', () => ({ currentPortalSession: vi.fn() }));
vi.mock('@/modules/accounting/services/afs/afsReportingPeriod', () => ({ findReportingPeriod: vi.fn() }));

import { ManagementPackViewer } from '@/components/accounting/afs/ManagementPackViewer';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import { renderToDocx } from '@/modules/accounting/services/afs/docxExportService';
import PortalDocumentPage from '../../../pages/accounting/afs/portal/documents/[documentId]';
import type { AfsDocument, AfsSection, BrandProfile } from '@/modules/accounting/services/afs/afsTypes';

afterEach(cleanup);
const DOC = { id: 'd', period: '2026-10', documentType: 'management_pack', fiscalYear: null } as unknown as AfsDocument;
const brand = { primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', fontFamily: 'professional', coverStyle: 'classic', logoUrl: null } as unknown as BrandProfile;
const T = { type: 'table', headers: ['', 'This month'], rows: [['Net profit', 'R 4.00']], rowKinds: ['total'] };
const content = { title: 'Income Statement', blocks: [T] };

async function surfaces(s: { overrides: unknown; aiNarrative: string | null; accepted: boolean }): Promise<string[]> {
  const app = [{ id: 'a', sectionType: 'income_statement', sortOrder: 0, content, overrides: s.overrides, aiNarrative: s.aiNarrative, aiNarrativeAccepted: s.accepted }] as unknown as AfsSection[];
  const pdf = renderAfsToHtml({ document: DOC, sections: app, brandProfile: brand, companyName: 'A', registrationNumber: '' } as AfsRenderContext);
  const docx = await (await JSZip.loadAsync(await renderToDocx(DOC, app, 'A'))).file('word/document.xml')!.async('string');
  const v = render(<ManagementPackViewer sections={app} />); const viewer = v.container.textContent ?? ''; cleanup();
  const props = { document: { id: 'd', fiscal_year: null, period: '2026-10', document_type: 'management_pack', status: 'draft', signing_requested_at: null },
    sections: [{ id: 'a', section_type: 'income_statement', sort_order: 0, status: 'x', content, overrides: s.overrides, ai_narrative: s.aiNarrative, ai_narrative_accepted: s.accepted }], canAnnotate: false } as unknown as Parameters<typeof PortalDocumentPage>[0];
  const p = render(<PortalDocumentPage {...props} />); const portal = p.container.textContent ?? ''; cleanup();
  return [pdf, docx, viewer, portal];
}
const count = (h: string, t: string) => h.split(t).length - 1;

describe('flag parity on PDF, DOCX, viewer, portal', () => {
  it('not accepted: the narrative prints once everywhere', async () => {
    for (const h of await surfaces({ overrides: null, aiNarrative: 'Sales held.', accepted: false })) expect(count(h, 'Sales held.')).toBe(1);
  });
  it('accepted then edited: only the edit prints everywhere', async () => {
    const edited = { title: 'Income Statement', blocks: [T, { type: 'paragraph', text: 'Sales held at R10.' }] };
    for (const h of await surfaces({ overrides: edited, aiNarrative: 'Sales held.', accepted: true })) {
      expect(count(h, 'Sales held at R10.')).toBe(1);
      expect(count(h, 'Sales held.')).toBe(0);
    }
  });
  it('accepted, then regenerated: POST .../ai-narrative now clears the flag (aiNarrativeAccepted.test.ts), so the new narrative prints beside the old accepted copy', async () => {
    const accepted = { title: 'Income Statement', blocks: [T, { type: 'paragraph', text: 'Old words.' }] };
    for (const h of await surfaces({ overrides: accepted, aiNarrative: 'New words after regenerate.', accepted: false })) {
      expect(count(h, 'New words after regenerate.')).toBe(1);
      expect(count(h, 'Old words.')).toBe(1);
    }
  });
});
