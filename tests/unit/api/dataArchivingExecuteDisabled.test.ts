/**
 * Executing an archive is switched off. `executeArchive` deletes posted
 * journals, reconciled bank lines and settled invoices before the cutoff, and
 * no report reads the archive tables, so every trial balance, balance sheet and
 * VAT201 from before the cutoff would lose that history. The POST refuses for
 * every role and never reaches the service; stats, validate and preview stay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/dataArchivingService', () => ({
  getStorageStats: vi.fn(),
  previewArchive: vi.fn(),
  validateArchive: vi.fn(),
  executeArchive: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/archiveExecutionService', () => ({
  executeArchive: vi.fn(),
}));

import handler from '../../../pages/api/accounting/data-archiving';
import * as archiving from '@/modules/accounting/services/core/dataArchivingService';
import * as execution from '@/modules/accounting/services/core/archiveExecutionService';

function mockReqRes(method: string, companyRole: string, query: Record<string, string> = {}) {
  const req = {
    method, query, body: { cutoffDate: '2019-01-01' },
    companyId: '11111111-1111-4111-8111-111111111111', companyRole,
    user: { id: '99999999-9999-4999-8999-999999999999' },
  } as unknown as NextApiRequest;
  const res = {
    statusCode: 0,
    sent: undefined as unknown,
    setHeader() { return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    send(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return { req, res: res as unknown as NextApiResponse & typeof res };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /api/accounting/data-archiving — archiving is switched off', () => {
  for (const role of ['owner', 'admin']) {
    it(`refuses an ${role} and never runs the archive`, async () => {
      vi.mocked(archiving.validateArchive).mockResolvedValue({ valid: true, errors: [] });
      const { req, res } = mockReqRes('POST', role);

      await handler(req, res);

      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.sent)).toMatch(/switched off/i);
      expect(archiving.executeArchive).not.toHaveBeenCalled();
      expect(execution.executeArchive).not.toHaveBeenCalled();
    });
  }

  it('still answers a preview', async () => {
    vi.mocked(archiving.previewArchive).mockResolvedValue({ totalRecords: 0 } as never);
    const { req, res } = mockReqRes('GET', 'owner', { action: 'preview', cutoff: '2019-01-01' });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(archiving.previewArchive).toHaveBeenCalled();
  });
});
