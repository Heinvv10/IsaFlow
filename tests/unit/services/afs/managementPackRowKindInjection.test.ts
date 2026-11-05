/**
 * `rowKinds` is stored section content (a tenant writes it through the overrides route), and the PDF
 * renderer puts it in a class attribute that WeasyPrint parses. Only the four known kinds may reach
 * the page; anything else is a plain row, and the overrides route refuses it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { renderAfsToHtml, type AfsRenderContext } from '@/modules/accounting/services/afs/afsHtmlRendererService';
import { overridesRowKindsValid, safeRowKind } from '@/modules/accounting/services/afs/managementPackSections';
import type { AfsDocument, AfsSection, BrandProfile, NoteContentBlock } from '@/modules/accounting/services/afs/afsTypes';

const m = vi.hoisted(() => ({ sql: vi.fn(), apiResponse: { zodValidationError: vi.fn(), success: vi.fn(), methodNotAllowed: vi.fn(), notFound: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withWriteAccess', () => ({ withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/apiResponse', () => ({ apiResponse: m.apiResponse, ErrorCode: { CONFLICT: 'CONFLICT' } }));
vi.mock('@/modules/accounting/services/afs/afsReviewService', () => ({ assertDocumentEditable: vi.fn(), ReviewError: class extends Error {} }));
vi.mock('@/modules/accounting/services/afs/afsVersionHistoryService', () => ({ saveVersion: vi.fn(async () => ({})), VersionHistoryError: class extends Error {} }));
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/
import overridesHandler from '../../../../pages/api/accounting/afs/[documentId]/sections/[sectionId]/overrides';

const EVIL = 'x"><img src=http://127.0.0.1/ssrf>';
const brand = { id: 'b', companyId: 'c', logoUrl: null, primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', fontFamily: 'professional', coverStyle: 'classic', reportFooterText: null, createdAt: new Date(), updatedAt: new Date() } as BrandProfile;
const PACK = { id: 'd', companyId: 'c', fiscalYear: null, period: '2026-10', documentType: 'management_pack', reportingFramework: 'ifrs_smes', status: 'draft', version: 1 } as unknown as AfsDocument;
const table = (rowKinds: unknown): NoteContentBlock => ({ type: 'table', headers: ['', 'A'], rows: [['one', '1'], ['two', '2']], rowKinds } as unknown as NoteContentBlock);
const pack = (blocks: NoteContentBlock[], where: 'content' | 'overrides'): string => renderAfsToHtml({
  document: PACK, brandProfile: brand, companyName: 'Acme', registrationNumber: '1',
  sections: [{ id: 's1', sectionType: 'kpi_scorecard', sortOrder: 0, aiNarrative: null,
    content: where === 'content' ? { title: 'KPI Scorecard', blocks } : { title: 'KPI Scorecard', blocks: [] },
    overrides: where === 'overrides' ? { title: 'KPI Scorecard', blocks } : null } as unknown as AfsSection],
} as AfsRenderContext);

describe('the PDF html never carries a stored row kind unchecked', () => {
  it.each(['content', 'overrides'] as const)('a hostile kind in %s is a plain row, and no markup reaches the page', (where) => {
    const html = pack([table([EVIL, 'subtotal'])], where);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('127.0.0.1');
    expect(html).not.toContain(EVIL);
    expect(html).toMatch(/<tr><td>one<\/td>/);
    expect(html).toContain('<tr class="row-subtotal"><td>two</td>');
  });

  it('a non-string, a prototype name and a non-array are plain rows', () => {
    for (const kinds of [[{ a: 1 }, 'constructor'], 'total', null]) {
      const html = pack([table(kinds)], 'content');
      expect(html).not.toContain('class="row-');
      expect(html).toMatch(/<tr><td>one<\/td>/);
    }
  });

  it('the four known kinds still style their rows', () => {
    const html = pack([table(['heading', 'total'])], 'content');
    expect(html).toContain('<tr class="row-heading">');
    expect(html).toContain('<tr class="row-total">');
  });
});

describe('safeRowKind', () => {
  it('passes the four kinds and nothing else', () => {
    for (const k of ['heading', 'line', 'subtotal', 'total']) expect(safeRowKind(k)).toBe(k);
    for (const k of [EVIL, 'constructor', '__proto__', '', 5, null, undefined, ['total']]) expect(safeRowKind(k)).toBe('line');
  });
});

describe('the overrides route', () => {
  beforeEach(() => { vi.clearAllMocks(); m.sql.mockResolvedValue([{ id: 's' }]); });
  const call = async (overrides: Record<string, unknown>) => {
    const req = { method: 'PUT', query: { documentId: '33333333-3333-4333-8333-333333333333', sectionId: '44444444-4444-4444-8444-444444444444' }, body: { overrides }, companyId: 'c', user: { id: 'u' } } as unknown as NextApiRequest;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as NextApiResponse;
    await (overridesHandler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, res);
  };

  it('refuses a table whose rowKinds holds anything but the four kinds, and writes nothing', async () => {
    await call({ blocks: [table(['total', EVIL])] });
    expect(m.apiResponse.zodValidationError).toHaveBeenCalledTimes(1);
    expect(m.sql).not.toHaveBeenCalled();
  });

  it('accepts known kinds and overrides with no tables', async () => {
    await call({ blocks: [table(['heading', 'line', 'subtotal', 'total'])] });
    expect(m.apiResponse.zodValidationError).not.toHaveBeenCalled();
    expect(m.sql).toHaveBeenCalled();
    expect(overridesRowKindsValid({ title: 'x' })).toBe(true);
    expect(overridesRowKindsValid({ blocks: [{ type: 'paragraph', text: 'x' }] })).toBe(true);
    expect(overridesRowKindsValid({ blocks: [table('total')] })).toBe(false);
  });
});
