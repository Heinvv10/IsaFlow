/**
 * Wave 6 EF (review L6): a certificate line is labelled from the nearest year that has the code when its own tax
 * year's catalogue lacks it; validation stays exact-year (getSarsCode / isKnownSarsCode).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ catalogue: [] as Array<{ code: string; effective_year: number; description: string }> }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?');
    if (q.includes('ORDER BY abs(effective_year')) {
      const [code, year] = values as [string, number];
      const hits = st.catalogue.filter((r) => r.code === code)
        .sort((a, b) => Math.abs(a.effective_year - year) - Math.abs(b.effective_year - year) || b.effective_year - a.effective_year);
      return hits.slice(0, 1).map((r) => ({ effective_year: r.effective_year }));
    }
    const [year] = values as [number];
    return st.catalogue.filter((r) => r.effective_year === year).map((r) => ({
      ...r, category: 'deduction', status: 'active', foreign_code: null, code_pair: null, applicability_note: null,
      rationalisation_note: null, source_document: null, source_url: null, official_excerpt: null, brs_version: null,
    }));
  }),
}));

import { getSarsCode, getSarsCodeNearest, isKnownSarsCode, refreshCache } from '@/modules/accounting/services/payroll/sarsCodesService';

beforeEach(() => {
  refreshCache();
  st.catalogue = [
    { code: '4005', effective_year: 2026, description: 'Medical scheme fees (2026)' },
    { code: '4005', effective_year: 2027, description: 'Medical scheme fees (2027)' },
    { code: '4590', effective_year: 2027, description: '2027-only code' },
  ];
});

describe('getSarsCodeNearest', () => {
  it('answers from the year itself when it has the code', async () => {
    expect((await getSarsCodeNearest('4005', 2026))!.description).toBe('Medical scheme fees (2026)');
  });
  it('falls back to the nearest year that has the code (2024 lacks 4005: 2026 answers)', async () => {
    const c = (await getSarsCodeNearest('4005', 2024))!;
    expect([c.description, c.effectiveYear]).toEqual(['Medical scheme fees (2026)', 2026]);
  });
  it('a year after the catalogue takes the latest', async () => {
    expect((await getSarsCodeNearest('4005', 2030))!.effectiveYear).toBe(2027);
  });
  it('null when no year has the code', async () => {
    expect(await getSarsCodeNearest('9999', 2027)).toBeNull();
  });
  it('validation stays exact-year: a 2027-only code is unknown in 2026', async () => {
    expect(await getSarsCode('4590', 2026)).toBeNull();
    expect(await isKnownSarsCode('4590', 2026)).toBe(false);
    expect((await getSarsCodeNearest('4590', 2026))!.effectiveYear).toBe(2027);
  });
});
