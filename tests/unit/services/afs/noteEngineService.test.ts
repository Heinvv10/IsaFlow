import { describe, it, expect, vi, beforeEach } from 'vitest';

// The section write guard is proven against real PostgreSQL in
// tests/integration/controls/afsSectionWritesHttp.int.test.ts.
vi.mock('@/modules/accounting/services/afs/afsSectionAttestation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/afs/afsSectionAttestation')>()),
  lockSectionForWrite: vi.fn().mockResolvedValue({
    id: 'section', documentId: 'document', sectionType: 'note', status: 'pending', reviewedBy: null, signedOffBy: null,
  }),
  voidSectionAttestation: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/afs/noteGenerators', () => ({
  NOTE_GENERATOR_MAP: {
    note_1: vi.fn(),
  },
}));
vi.mock('@/modules/accounting/services/afs/noteDataQueryService', () => ({
  isZeroBalance: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { NOTE_GENERATOR_MAP } from '@/modules/accounting/services/afs/noteGenerators';
import { isZeroBalance } from '@/modules/accounting/services/afs/noteDataQueryService';
import { generateSection, generateAllSections } from '@/modules/accounting/services/afs/noteEngineService';

const COMPANY_ID  = 'ccc11111-0000-0000-0000-000000000001';
const DOCUMENT_ID = 'ddd22222-0000-0000-0000-000000000002';
const SECTION_ID  = 'sss33333-0000-0000-0000-000000000003';
const USER_ID = '44444444-4444-4444-9444-444444444444';
const FISCAL_YEAR = 2025;
const FRAMEWORK   = 'ifrs_smes' as const;

const MOCK_DATA_SNAPSHOT = { items: [{ id: 1 }] };
const MOCK_CONTENT = { title: 'Note 1', blocks: [] };

function mockSql(returnValue: unknown[]) {
  vi.mocked(sql).mockImplementation(() => Promise.resolve(returnValue) as ReturnType<typeof sql>);
}

describe('noteEngineService', () => {
  beforeEach(() => vi.clearAllMocks());

  // ── generateSection ──────────────────────────────────────────────────────────

  describe('generateSection', () => {
    it('happy path: fetches section, runs generator, persists content, enqueues AI job', async () => {
      // Stage 1 returns a valid section row
      vi.mocked(sql)
        .mockImplementationOnce(() =>
          Promise.resolve([
            { section_type: 'note_1', status: 'pending', is_mandatory: false, ai_prompt_template: 'Summarise note 1' },
          ]) as ReturnType<typeof sql>,
        )
        // Stage 4 UPDATE
        .mockImplementationOnce(() => Promise.resolve([]) as ReturnType<typeof sql>);

      vi.mocked(NOTE_GENERATOR_MAP.note_1!).mockResolvedValueOnce({
        dataSnapshot: MOCK_DATA_SNAPSHOT,
        content: MOCK_CONTENT,
      });
      vi.mocked(isZeroBalance).mockReturnValueOnce(false);

      await generateSection(COMPANY_ID, DOCUMENT_ID, SECTION_ID, FISCAL_YEAR, FRAMEWORK, USER_ID);

      expect(NOTE_GENERATOR_MAP.note_1).toHaveBeenCalledWith(COMPANY_ID, FISCAL_YEAR, FRAMEWORK);
      expect(sql).toHaveBeenCalledTimes(2); // fetch + update
      expect(log.info).toHaveBeenCalledWith(
        'AI narrative enqueued (no section_id column — logged only)',
        expect.objectContaining({ companyId: COMPANY_ID, sectionId: SECTION_ID }),
        'noteEngineService',
      );
    });

    it('suppresses zero-balance non-mandatory section (status = pending, returns early)', async () => {
      vi.mocked(sql)
        .mockImplementationOnce(() =>
          Promise.resolve([
            { section_type: 'note_1', status: 'pending', is_mandatory: false, ai_prompt_template: null },
          ]) as ReturnType<typeof sql>,
        )
        // Stage 3 suppress UPDATE
        .mockImplementationOnce(() => Promise.resolve([]) as ReturnType<typeof sql>);

      vi.mocked(NOTE_GENERATOR_MAP.note_1!).mockResolvedValueOnce({
        dataSnapshot: { items: [] },
        content: MOCK_CONTENT,
      });
      vi.mocked(isZeroBalance).mockReturnValueOnce(true);

      await generateSection(COMPANY_ID, DOCUMENT_ID, SECTION_ID, FISCAL_YEAR, FRAMEWORK, USER_ID);

      // Only 2 sql calls: fetch + suppress update (no persist update)
      expect(sql).toHaveBeenCalledTimes(2);

      // Verify the second sql call contains 'pending' (suppress status)
      const secondCall = vi.mocked(sql).mock.calls[1];
      const flatArgs = secondCall.flat();
      const allStrings = flatArgs.filter((a): a is string => typeof a === 'string');
      expect(allStrings.some(s => s.includes('pending'))).toBe(true);
    });

    it('does NOT suppress zero-balance mandatory section', async () => {
      vi.mocked(sql)
        .mockImplementationOnce(() =>
          Promise.resolve([
            { section_type: 'note_1', status: 'pending', is_mandatory: true, ai_prompt_template: null },
          ]) as ReturnType<typeof sql>,
        )
        // Stage 4 persist UPDATE
        .mockImplementationOnce(() => Promise.resolve([]) as ReturnType<typeof sql>);

      vi.mocked(NOTE_GENERATOR_MAP.note_1!).mockResolvedValueOnce({
        dataSnapshot: { items: [] },
        content: MOCK_CONTENT,
      });
      vi.mocked(isZeroBalance).mockReturnValueOnce(true);

      await generateSection(COMPANY_ID, DOCUMENT_ID, SECTION_ID, FISCAL_YEAR, FRAMEWORK, USER_ID);

      // 2 sql calls: fetch + persist (mandatory → not suppressed)
      expect(sql).toHaveBeenCalledTimes(2);
      const secondCall = vi.mocked(sql).mock.calls[1];
      const flatArgs = secondCall.flat();
      const allStrings = flatArgs.filter((a): a is string => typeof a === 'string');
      expect(allStrings.some(s => s.includes('auto_generated'))).toBe(true);
    });

    it('throws "Section not found or access denied" when sql returns empty', async () => {
      mockSql([]);

      await expect(
        generateSection(COMPANY_ID, DOCUMENT_ID, SECTION_ID, FISCAL_YEAR, FRAMEWORK, USER_ID),
      ).rejects.toThrow('Section not found or access denied');
    });

    it('throws "No generator for section type" when sectionType has no generator', async () => {
      vi.mocked(sql).mockImplementationOnce(() =>
        Promise.resolve([
          { section_type: 'note_99', status: 'pending', is_mandatory: false, ai_prompt_template: null },
        ]) as ReturnType<typeof sql>,
      );

      await expect(
        generateSection(COMPANY_ID, DOCUMENT_ID, SECTION_ID, FISCAL_YEAR, FRAMEWORK, USER_ID),
      ).rejects.toThrow('No generator for section type: note_99');
    });
  });

  // ── generateAllSections ──────────────────────────────────────────────────────

  describe('generateAllSections', () => {
    it('calls generateSection for each section concurrently', async () => {
      // First sql call: list sections
      vi.mocked(sql)
        .mockImplementationOnce(() =>
          Promise.resolve([
            { id: 'sec-1', section_type: 'note_1' },
            { id: 'sec-2', section_type: 'note_1' },
          ]) as ReturnType<typeof sql>,
        )
        // Each section: fetch row + update (2 sql calls each × 2 sections = 4)
        .mockImplementation(() =>
          Promise.resolve([
            { section_type: 'note_1', status: 'pending', is_mandatory: false, ai_prompt_template: null },
          ]) as ReturnType<typeof sql>,
        );

      vi.mocked(NOTE_GENERATOR_MAP.note_1!).mockResolvedValue({
        dataSnapshot: MOCK_DATA_SNAPSHOT,
        content: MOCK_CONTENT,
      });
      vi.mocked(isZeroBalance).mockReturnValue(false);

      await generateAllSections(COMPANY_ID, DOCUMENT_ID, FISCAL_YEAR, FRAMEWORK, USER_ID);

      // 1 (list) + 2 (sec-1: fetch + update) + 2 (sec-2: fetch + update) = 5
      expect(sql).toHaveBeenCalledTimes(5);
    });

    it('continues other sections and RETURNS the failure rather than only logging it', async () => {
      // First call: list sections
      vi.mocked(sql)
        .mockImplementationOnce(() =>
          Promise.resolve([
            { id: 'sec-1', section_type: 'note_1' },
            { id: 'sec-2', section_type: 'note_1' },
          ]) as ReturnType<typeof sql>,
        )
        // sec-1: fetch → returns unknown sectionType to trigger error
        .mockImplementationOnce(() =>
          Promise.resolve([
            { section_type: 'note_99', status: 'pending', is_mandatory: false, ai_prompt_template: null },
          ]) as ReturnType<typeof sql>,
        )
        // sec-2: fetch → valid
        .mockImplementationOnce(() =>
          Promise.resolve([
            { section_type: 'note_1', status: 'pending', is_mandatory: false, ai_prompt_template: null },
          ]) as ReturnType<typeof sql>,
        )
        // sec-2: update
        .mockImplementationOnce(() => Promise.resolve([]) as ReturnType<typeof sql>);

      vi.mocked(NOTE_GENERATOR_MAP.note_1!).mockResolvedValue({
        dataSnapshot: MOCK_DATA_SNAPSHOT,
        content: MOCK_CONTENT,
      });
      vi.mocked(isZeroBalance).mockReturnValue(false);

      // Should NOT throw even though sec-1 fails — and must hand the failure back
      const failures = await generateAllSections(COMPANY_ID, DOCUMENT_ID, FISCAL_YEAR, FRAMEWORK, USER_ID);
      expect(failures, 'a refused section was lost to a log line').toEqual([
        expect.objectContaining({ sectionId: 'sec-1' }),
      ]);

      // Error should be logged
      expect(log.error).toHaveBeenCalledWith(
        'Section generation failed',
        expect.objectContaining({ sectionId: 'sec-1', companyId: COMPANY_ID }),
        'noteEngineService',
      );
    });
  });
});
