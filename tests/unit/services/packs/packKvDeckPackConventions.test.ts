/**
 * The legacy pack documents (KV blocks, the PowerPoint deck) are pack output:
 * they take the pack's number conventions, not the screens' — a non-breaking
 * separator and a bracketed negative percentage.
 */
import { describe, expect, it } from 'vitest';
import { formatPackKv } from '@/modules/accounting/services/packs/packKvFormat';
import { buildPackDeck, type DeckTableSlide } from '@/modules/accounting/services/packs/packDeckModel';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

describe('formatPackKv', () => {
  it('prints a negative percentage in brackets, not with U+2212', () => {
    expect(formatPackKv({ label: 'Margin', value: -8.1, format: 'pct' })).toBe('(8.1%)');
  });
  it('separates thousands of cents-precision money with U+00A0', () => {
    expect(formatPackKv({ label: 'Cash', value: 1234567.5, format: 'money' })).toBe('1 234 567.50');
  });
});

describe('buildPackDeck statement rows', () => {
  it('separate thousands with U+00A0', () => {
    const doc: PackDocument = {
      packType: 'management', companyName: 'Demo', period: '2026', generatedAt: '2026-09-06T08:00:00.000Z',
      sections: [{ type: 'income_statement', title: 'IS', landscape: false, blocks: [
        { kind: 'statement', rows: [{ id: 'sub:r', kind: 'subtotal', label: 'Turnover', depth: 0, actual: 4812345.67 }] },
      ] }],
    };
    const slide = buildPackDeck(doc).find((s): s is DeckTableSlide => s.kind === 'table')!;
    expect(slide.rows[0]!.value).toBe('4 812 345.67');
  });
});
