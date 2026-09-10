import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
// The section write guard (document binding, lock check, review invalidation) is proven
// against real PostgreSQL in tests/integration/controls/afsSectionReviewIntegrityHttp.int.test.ts.
vi.mock('@/modules/accounting/services/afs/afsSectionAttestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/afs/afsSectionAttestation')>()),
  lockSectionForWrite: vi.fn().mockResolvedValue({
    id: 'section', documentId: 'document', sectionType: 'note', status: 'pending', reviewedBy: null, signedOffBy: null,
  }),
  voidSectionAttestation: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  createAfsSection,
  getAfsSectionsForDocument,
  updateAfsSection,
} from '@/modules/accounting/services/afs/afsSectionService';
import type { NoteContent } from '@/modules/accounting/services/afs/afsTypes';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'ccc11111-0000-0000-0000-000000000001';
const DOC_ID     = 'ddd11111-0000-0000-0000-000000000001';
const SECTION_ID = 'sss11111-0000-0000-0000-000000000001';
const USER_ID    = 'uuu11111-0000-0000-0000-000000000001';

const SECTION_ROW = {
  id: SECTION_ID,
  document_id: DOC_ID,
  company_id: COMPANY_ID,
  section_type: 'note_1',
  sort_order: 1,
  status: 'pending',
  data_snapshot: null,
  content: null,
  overrides: null,
  ai_narrative: null,
  ai_narrative_accepted: false,
  reviewed_by: null,
  reviewed_at: null,
  signed_off_by: null,
  signed_off_at: null,
  version_history: [],
  created_at: new Date('2026-01-01'),
  updated_at: new Date('2026-01-01'),
};

const SAMPLE_CONTENT: NoteContent = {
  title: 'Accounting Policies',
  blocks: [{ type: 'paragraph', text: 'Basis of preparation: IFRS for SMEs.' }],
};

describe('afsSectionService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('createAfsSection', () => {
    it('inserts a section and returns camelCase AfsSection', async () => {
      mockSql.mockResolvedValueOnce([SECTION_ROW]);

      const result = await createAfsSection({
        documentId: DOC_ID,
        companyId: COMPANY_ID,
        sectionType: 'note_1',
        sortOrder: 1,
      });

      expect(result.id).toBe(SECTION_ID);
      expect(result.documentId).toBe(DOC_ID);
      expect(result.companyId).toBe(COMPANY_ID);
      expect(result.sectionType).toBe('note_1');
      expect(result.status).toBe('pending');
      expect(result.versionHistory).toEqual([]);
      expect(mockSql).toHaveBeenCalledTimes(1);
    });

    it('throws when sql returns empty (duplicate section_type in document)', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(
        createAfsSection({ documentId: DOC_ID, companyId: COMPANY_ID, sectionType: 'note_1', sortOrder: 1 })
      ).rejects.toThrow('Failed to create AFS section');
    });
  });

  describe('getAfsSectionsForDocument', () => {
    it('returns all sections ordered by sort_order', async () => {
      const row2 = { ...SECTION_ROW, id: 'sss22222', section_type: 'note_2', sort_order: 2 };
      mockSql.mockResolvedValueOnce([SECTION_ROW, row2]);

      const result = await getAfsSectionsForDocument(DOC_ID, COMPANY_ID);

      expect(result).toHaveLength(2);
      expect(result[0]!.sectionType).toBe('note_1');
      expect(result[1]!.sectionType).toBe('note_2');
    });

    it('returns empty array when document has no sections', async () => {
      mockSql.mockResolvedValueOnce([]);

      const result = await getAfsSectionsForDocument(DOC_ID, COMPANY_ID);

      expect(result).toEqual([]);
    });
  });

  describe('updateAfsSection', () => {
    it('updates content and status, appends to version_history', async () => {
      const updatedRow = {
        ...SECTION_ROW,
        status: 'auto_generated',
        content: SAMPLE_CONTENT,
        version_history: [
          { version: 1, savedAt: '2026-04-16T00:00:00Z', savedBy: USER_ID, content: SAMPLE_CONTENT },
        ],
      };
      mockSql.mockResolvedValueOnce([updatedRow]);

      const result = await updateAfsSection(SECTION_ID, DOC_ID, COMPANY_ID, {
        status: 'auto_generated',
        content: SAMPLE_CONTENT,
      });

      expect(result.status).toBe('auto_generated');
      expect(result.content).toEqual(SAMPLE_CONTENT);
      expect(result.versionHistory).toHaveLength(1);
    });

    it('updates status without appending to version_history when content not provided', async () => {
      const updatedRow = { ...SECTION_ROW, status: 'reviewed', version_history: [] };
      mockSql.mockResolvedValueOnce([updatedRow]);

      const result = await updateAfsSection(SECTION_ID, DOC_ID, COMPANY_ID, { status: 'reviewed' });

      expect(result.status).toBe('reviewed');
      expect(result.versionHistory).toHaveLength(0);
    });

    it('throws when section not found', async () => {
      mockSql.mockResolvedValueOnce([]);

      await expect(
        updateAfsSection('nonexistent', DOC_ID, COMPANY_ID, { status: 'reviewed' })
      ).rejects.toThrow('Section not found');
    });
  });
});
