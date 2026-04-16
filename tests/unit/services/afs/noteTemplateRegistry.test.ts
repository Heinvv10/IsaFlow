import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import {
  seedNoteTemplates,
  getNoteTemplatesForFramework,
  ALL_NOTE_TEMPLATES,
} from '@/modules/accounting/services/afs/noteTemplateRegistry';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

describe('noteTemplateRegistry', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('ALL_NOTE_TEMPLATES static array', () => {
    it('contains exactly 30 note templates', () => {
      const noteTemplates = ALL_NOTE_TEMPLATES.filter(t => t.sectionType.startsWith('note_'));
      expect(noteTemplates).toHaveLength(30);
    });

    it('has a template for note_1 (Accounting Policies) applicable to both frameworks', () => {
      const note1 = ALL_NOTE_TEMPLATES.find(t => t.sectionType === 'note_1');
      expect(note1).toBeDefined();
      expect(note1!.framework).toBe('both');
      expect(note1!.isMandatory).toBe(true);
      expect(note1!.title).toMatch(/accounting polic/i);
    });

    it('has note_4 (Right-of-Use Assets) applicable to full_ifrs only', () => {
      const note4 = ALL_NOTE_TEMPLATES.find(t => t.sectionType === 'note_4');
      expect(note4).toBeDefined();
      expect(note4!.framework).toBe('full_ifrs');
    });

    it('has note_14 (Lease Liabilities IFRS 16) applicable to full_ifrs only', () => {
      const note14 = ALL_NOTE_TEMPLATES.find(t => t.sectionType === 'note_14');
      expect(note14).toBeDefined();
      expect(note14!.framework).toBe('full_ifrs');
    });

    it('has note_28 (Segment Information) applicable to full_ifrs only', () => {
      const note28 = ALL_NOTE_TEMPLATES.find(t => t.sectionType === 'note_28');
      expect(note28).toBeDefined();
      expect(note28!.framework).toBe('full_ifrs');
    });

    it('every template has a non-empty title', () => {
      for (const t of ALL_NOTE_TEMPLATES) {
        expect(t.title.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getNoteTemplatesForFramework', () => {
    it('returns both-framework and ifrs_smes templates for ifrs_smes', () => {
      const templates = getNoteTemplatesForFramework('ifrs_smes');
      expect(templates.every(t => t.framework === 'both' || t.framework === 'ifrs_smes')).toBe(true);
    });

    it('returns both-framework and full_ifrs templates for full_ifrs', () => {
      const templates = getNoteTemplatesForFramework('full_ifrs');
      expect(templates.every(t => t.framework === 'both' || t.framework === 'full_ifrs')).toBe(true);
    });

    it('full_ifrs returns more templates than ifrs_smes (has IFRS16 sections)', () => {
      const smes = getNoteTemplatesForFramework('ifrs_smes');
      const full = getNoteTemplatesForFramework('full_ifrs');
      expect(full.length).toBeGreaterThan(smes.length);
    });
  });

  describe('seedNoteTemplates', () => {
    it('calls sql once per template (upsert)', async () => {
      mockSql.mockResolvedValue([{ id: 'some-id' }]);
      await seedNoteTemplates();
      expect(mockSql).toHaveBeenCalledTimes(ALL_NOTE_TEMPLATES.length);
    });

    it('does not throw when all upserts succeed', async () => {
      mockSql.mockResolvedValue([{ id: 'some-id' }]);
      await expect(seedNoteTemplates()).resolves.not.toThrow();
    });
  });
});
