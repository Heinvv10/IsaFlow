// A document id (an AFS document or a management pack) from another company is a 404, on the document
// route and on the period route the page asks first.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const m = vi.hoisted(() => ({ getAfsDocument: vi.fn(), getSections: vi.fn(), sql: vi.fn() }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', () => ({ fiscalYearForDate: vi.fn(), getFiscalYear: vi.fn() }));
vi.mock('@/modules/accounting/services/afs/afsDocumentService', () => ({ getAfsDocument: m.getAfsDocument }));
vi.mock('@/modules/accounting/services/afs/afsSectionService', () => ({ getAfsSectionsForDocument: m.getSections }));
vi.mock('@/lib/apiResponse', () => ({ apiResponse: { success: vi.fn(), notFound: vi.fn(), methodNotAllowed: vi.fn() } }));

import { apiResponse } from '@/lib/apiResponse';
import docHandler from '../../../pages/api/accounting/afs/[documentId]/index';
import periodHandler from '../../../pages/api/accounting/afs/[documentId]/period';

type H = (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
const req = () => ({ method: 'GET', query: { documentId: 'pack-1' }, companyId: 'co-A' }) as unknown as NextApiRequest;
const res = {} as NextApiResponse;
beforeEach(() => vi.clearAllMocks());

describe('document id from another company', () => {
  it('document route: looked up under the session company; a miss is 404 and reads no sections', async () => {
    m.getAfsDocument.mockResolvedValue(null);
    await (docHandler as unknown as H)(req(), res);
    expect(m.getAfsDocument).toHaveBeenCalledWith('pack-1', 'co-A');
    expect(apiResponse.notFound).toHaveBeenCalled();
    expect(m.getSections).not.toHaveBeenCalled();
    expect(apiResponse.success).not.toHaveBeenCalled();
  });
  it('document route: a management pack of the session company returns its sections', async () => {
    m.getAfsDocument.mockResolvedValue({ id: 'pack-1', documentType: 'management_pack' });
    m.getSections.mockResolvedValue([{ sectionType: 'cover', sortOrder: 0 }]);
    await (docHandler as unknown as H)(req(), res);
    expect(m.getSections).toHaveBeenCalledWith('pack-1', 'co-A');
    expect(apiResponse.success).toHaveBeenCalledWith(res, { document: { id: 'pack-1', documentType: 'management_pack', sections: [{ sectionType: 'cover', sortOrder: 0 }] } });
  });
  it('period route: the query is scoped to the session company and an empty result is 404', async () => {
    m.sql.mockResolvedValue([]);
    await (periodHandler as unknown as H)(req(), res);
    const [strings, ...values] = m.sql.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toMatch(/company_id\s*=\s*\?::UUID/);
    expect(values).toEqual(['pack-1', 'co-A']);
    expect(apiResponse.notFound).toHaveBeenCalled();
  });
});
