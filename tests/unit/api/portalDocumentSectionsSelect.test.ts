/**
 * The portal's document route returns each section's overrides (the accountant's edits), which the PDF and the
 * app print: a client reading the pack in the portal sees the same text. Still scoped by document and company.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ sql: vi.fn(), sections: undefined as [string, unknown[]] | undefined }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/portalAuth', () => ({ withPortalAuth: (h: unknown) => h }));
vi.mock('@/lib/apiResponse', () => ({ apiResponse: { success: vi.fn(), forbidden: vi.fn(), notFound: vi.fn(), badRequest: vi.fn(), methodNotAllowed: vi.fn() } }));

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pages/ is outside src/
import handler from '../../../pages/api/accounting/portal/documents/[documentId]';

describe('portal document sections', () => {
  it('selects overrides, for this document and company only', async () => {
    m.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (text.includes('FROM afs_documents')) return [{ id: 'd', document_type: 'management_pack', status: 'draft' }];
      if (text.includes('FROM afs_sections')) { m.sections = [text, values]; return []; }
      return [];
    });
    const req = { method: 'GET', query: { documentId: '33333333-3333-4333-8333-333333333333' }, portalSession: { companyId: 'co', role: 'cfo' } } as unknown as NextApiRequest;
    await (handler as unknown as (a: NextApiRequest, b: NextApiResponse) => Promise<void>)(req, {} as NextApiResponse);
    const captured = m.sections;
    expect(captured?.[0]).toMatch(/SELECT[^;]*\boverrides\b[^;]*FROM afs_sections/);
    expect(captured?.[0]).toMatch(/company_id = \?::UUID/);
    expect(captured?.[1]).toContain('co');
  });
});
