import { describe, it, expect } from 'vitest';
import {
  buildSlides, clampSlide, type ReportPack,
} from '@/components/accounting/present/presentSlides';

const PACK: ReportPack = {
  type: 'board',
  companyName: 'Britech (Pty) Ltd',
  period: '1 Aug 2026 – 31 Aug 2026',
  generatedAt: '2026-09-06T08:00:00.000Z',
  sections: [
    { type: 'income_statement', title: 'Income Statement', data: { revenue: 1 } },
    { type: 'balance_sheet', title: 'Balance Sheet', data: { totalAssets: 2 } },
    { type: 'nonsense', title: 'Something new', data: {} },
  ],
};

describe('buildSlides', () => {
  const slides = buildSlides(PACK);

  it('opens with a cover carrying the company, period and pack name', () => {
    expect(slides[0]!.kind).toBe('cover');
    expect(slides[0]!.title).toContain('Britech');
    expect(slides[0]!.data['period']).toBe('1 Aug 2026 – 31 Aug 2026');
  });

  it('makes one slide per known section, in pack order', () => {
    expect(slides.slice(1).map((s) => s.kind)).toEqual(['income_statement', 'balance_sheet']);
  });

  it('drops a section kind it cannot render rather than paging to a blank slide', () => {
    expect(slides.map((s) => s.title)).not.toContain('Something new');
  });

  it('gives every slide a stable unique id', () => {
    const ids = slides.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildSlides(PACK).map((s) => s.id)).toEqual(ids);
  });

  it('carries the section data through untouched', () => {
    expect(slides[1]!.data).toBe(PACK.sections[0]!.data);
  });

  it('still produces a cover for a pack with no renderable sections', () => {
    expect(buildSlides({ ...PACK, sections: [] })).toHaveLength(1);
  });
});

describe('clampSlide', () => {
  it('holds at the first and last slide instead of wrapping', () => {
    expect(clampSlide(-1, 4)).toBe(0);
    expect(clampSlide(9, 4)).toBe(3);
    expect(clampSlide(2, 4)).toBe(2);
  });
  it('returns 0 for an empty deck', () => {
    expect(clampSlide(3, 0)).toBe(0);
  });
});
