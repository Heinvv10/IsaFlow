import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  createAfsDocument,
  getAfsDocument,
  listAfsDocuments,
  lockAfsDocument,
  AfsDocumentDuplicateError,
} from '@/modules/accounting/services/afs/afsDocumentService';
import type { AfsDocument } from '@/modules/accounting/services/afs/afsTypes';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'ccc11111-0000-0000-0000-000000000001';
const DOC_ID     = 'ddd11111-0000-0000-0000-000000000001';
const USER_ID    = 'uuu11111-0000-0000-0000-000000000001';

const DB_ROW = {
  id: DOC_ID,
  company_id: COMPANY_ID,
  fiscal_year: 2025,
  period: null,
  document_type: 'afs',
  reporting_framework: 'ifrs_smes',
  status: 'draft',
  locked_at: null,
  locked_by: null,
  version: 1,
  pis_score: null,
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

describe('afsDocumentService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('createAfsDocument', () => {
    it('inserts a new document and returns camelCase AfsDocument', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW]);

      const result = await createAfsDocument({
        companyId: COMPANY_ID,
        fiscalYear: 2025,
        documentType: 'afs',
        reportingFramework: 'ifrs_smes',
      });

      expect(result.id).toBe(DOC_ID);
      expect(result.companyId).toBe(COMPANY_ID);
      expect(result.fiscalYear).toBe(2025);
      expect(result.documentType).toBe('afs');
      expect(result.reportingFramework).toBe('ifrs_smes');
      expect(result.status).toBe('draft');
      expect(result.version).toBe(1);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('throws when sql returns empty array (DO NOTHING silent conflict)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(
        createAfsDocument({
          companyId: COMPANY_ID,
          fiscalYear: 2025,
          documentType: 'afs',
          reportingFramework: 'ifrs_smes',
        })
      ).rejects.toThrow('Failed to create AFS document');
    });

    it('translates Postgres unique-violation (SQLSTATE 23505) into AfsDocumentDuplicateError', async () => {
      // Simulate a real Postgres error object — the matcher must inspect
      // err.code, not err.message, so message-locale changes don't break it.
      const pgErr = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
      mockSql.mockRejectedValueOnce(pgErr);

      const promise = createAfsDocument({
        companyId: COMPANY_ID,
        fiscalYear: 2025,
        documentType: 'afs',
        reportingFramework: 'ifrs_smes',
      });

      await expect(promise).rejects.toThrow(AfsDocumentDuplicateError);
      await expect(promise).rejects.toThrow('AFS document for fiscal year 2025');
    });

    it('translates 23505 for management_pack with the period in the message', async () => {
      const pgErr = Object.assign(new Error('uq_afs_documents_company_period'), { code: '23505' });
      mockSql.mockRejectedValueOnce(pgErr);

      const promise = createAfsDocument({
        companyId: COMPANY_ID,
        period: '2026-01',
        documentType: 'management_pack',
        reportingFramework: 'ifrs_smes',
      });

      await expect(promise).rejects.toThrow(AfsDocumentDuplicateError);
      await expect(promise).rejects.toThrow('management pack for 2026-01');
    });

    it('does NOT translate non-23505 errors (lets the real DB error propagate)', async () => {
      const pgErr = Object.assign(new Error('connection terminated'), { code: '57P01' });
      mockSql.mockRejectedValueOnce(pgErr);

      const promise = createAfsDocument({
        companyId: COMPANY_ID,
        fiscalYear: 2025,
        documentType: 'afs',
        reportingFramework: 'ifrs_smes',
      });

      await expect(promise).rejects.not.toBeInstanceOf(AfsDocumentDuplicateError);
      await expect(promise).rejects.toThrow('connection terminated');
    });

    it('does NOT translate when error has no code (locale-independent guard)', async () => {
      const plainErr = new Error('unique constraint violated');
      mockSql.mockRejectedValueOnce(plainErr);

      // Pre-fix this test would have falsely matched on the message regex.
      // Now the matcher only checks err.code === '23505'.
      const promise = createAfsDocument({
        companyId: COMPANY_ID,
        fiscalYear: 2025,
        documentType: 'afs',
        reportingFramework: 'ifrs_smes',
      });

      await expect(promise).rejects.not.toBeInstanceOf(AfsDocumentDuplicateError);
      await expect(promise).rejects.toThrow('unique constraint violated');
    });
  });

  describe('getAfsDocument', () => {
    it('returns the document when found', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW]);

      const result = await getAfsDocument(DOC_ID, COMPANY_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(DOC_ID);
      expect(result!.companyId).toBe(COMPANY_ID);
    });

    it('returns null when document not found', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getAfsDocument('nonexistent', COMPANY_ID);

      expect(result).toBeNull();
    });

    it('enforces company_id scoping (never returns another company document)', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getAfsDocument(DOC_ID, 'other-company-id');

      expect(result).toBeNull();
      expect(mockSql).toHaveBeenCalledTimes(1);
    });
  });

  describe('listAfsDocuments', () => {
    it('returns array of documents for the company', async () => {
      mockSql.mockResolvedValueOnce([DB_ROW, { ...DB_ROW, id: 'ddd22222-0000-0000-0000-000000000002', fiscal_year: 2024 }]);

      const result = await listAfsDocuments(COMPANY_ID);

      expect(result).toHaveLength(2);
      expect(result[0]!.companyId).toBe(COMPANY_ID);
      expect(result[1]!.fiscalYear).toBe(2024);
    });

    it('returns empty array when company has no documents', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await listAfsDocuments(COMPANY_ID);

      expect(result).toEqual([]);
    });
  });

  describe('lockAfsDocument', () => {
    it('sets status to signed_off, locked_at, and locked_by', async () => {
      const lockedRow = {
        ...DB_ROW,
        status: 'signed_off',
        locked_at: new Date('2026-04-16'),
        locked_by: USER_ID,
      };
      mockSql.mockResolvedValueOnce([lockedRow]);

      const result = await lockAfsDocument(DOC_ID, COMPANY_ID, USER_ID);

      expect(result.status).toBe('signed_off');
      expect(result.lockedBy).toBe(USER_ID);
      expect(result.lockedAt).toBeInstanceOf(Date);
    });

    it('throws when document not found or already locked', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(
        lockAfsDocument(DOC_ID, COMPANY_ID, USER_ID)
      ).rejects.toThrow('Document not found or already locked');
    });
  });
});
