/**
 * THE TEXT THE PACK PRINTS IS THE TEXT IT MEASURES (`packPrintedText.ts`): a variation selector 16 after a character with
 * no emoji presentation dropped, at the pack's input and where a block is stamped; after an emoji it stays.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { stampBlock } from '@/modules/accounting/services/packs/pages/packFigureFitStamp';
import { printedText, withPrintedText } from '@/modules/accounting/services/packs/pages/packPrintedText';
import type { PackPageBlock } from '@/modules/accounting/services/packs/pages/packPageModel';
import { asPrinted, VS16_TYPED } from '../../print/fixtures/everyBreakCensus';
import { demoInput } from './fixtures/boardPackInputs';
import { demoWithoutBudget } from './fixtures/widenedFigures';

describe('printedText', () => {
  it.each([
    ['Profit!\uFE0FTelecommunications', 'Profit!Telecommunications'], ['Directors/\uFE0F', 'Directors/'], ['-\uFE0F2024', '-2024'],
    ['$\uFE0F$\uFE0F', '$$'], ['a\uFE0F\uFE0Fb', 'ab'], ['e\u0301\uFE0F', '\u00E9'], ['&\u0301\uFE0F', '&\u0301'],
    ['\u2764\uFE0F', '\u2764\uFE0F'], ['1\uFE0F\u20E3', '1\uFE0F\u20E3'], ['#\uFE0F\u20E3', '#\uFE0F\u20E3'], ['\u00A9\uFE0F', '\u00A9\uFE0F'], ['\u2122\uFE0F', '\u2122\uFE0F'],
    ['Gross margin', 'Gross margin'], ['Cafe\u0301-2024', 'Caf\u00E9-2024'], ['Cafe\uFE0F\u0301-2024', 'Caf\u00E9-2024'], ['A\u030A', '\u00C5'], ['&\u0301(', '&\u0301('],
  ])('%j as printed is %j', (text, printed) => {
    expect(printedText(text)).toBe(printed);
  });

  it('on every character the pair table covers, a U+FE0F stays exactly where Unicode\'s emoji data gives an emoji style', () => {
    expect(VS16_TYPED.length).toBeGreaterThan(100_000);
    expect(VS16_TYPED.filter((t) => printedText(t) !== asPrinted(t)).map((t) => JSON.stringify(t)).slice(0, 20)).toEqual([]);
  });

  it('withPrintedText rewrites every string through arrays and plain objects, and leaves the rest (and an unchanged value) as it is', () => {
    const at = new Date(0);
    const value = { a: ['x!\uFE0F', { b: 'y/\uFE0F', n: 3 }], at, same: { c: 'z' } };
    const out = withPrintedText(value);
    expect(out).toEqual({ a: ['x!', { b: 'y/', n: 3 }], at, same: { c: 'z' } });
    expect(out.at).toBe(at);
    expect(out.same).toBe(value.same);
    expect(withPrintedText(value.same)).toBe(value.same);
  });
});

describe('where the pack applies it', () => {
  it('buildBoardPackPages reads its input as printed: no stray selector reaches the document', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const doc = buildBoardPackPages({ ...demoInput, companyLegalName: 'Acme!\uFE0F Holdings' });
      const text = JSON.stringify(doc);
      expect(text).toContain('Acme! Holdings');
      expect(text).not.toContain('!\uFE0F');
    } finally {
      warn.mockRestore();
    }
  });

  it('tenant text never reaches a KPI tile (whose layout has no wrap guard, and refuses a mark): every name, label, title and text the input carries tagged, the tiles hold none of it', () => {
    const named = /^(name|label|title|description|text|commentary|accountName|companyLegalName|preparedBy|reason)$/;
    const poison = (value: unknown, key = ''): unknown => {
      if (typeof value === 'string') return named.test(key) ? `${value} zq` : value;
      if (Array.isArray(value)) return value.map((v) => poison(v));
      if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, poison(v, k)]));
      }
      return value;
    };
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const input = poison(demoInput) as typeof demoInput;
      expect(JSON.stringify(input)).toContain(' zq');
      const doc = buildBoardPackPages(input);
      const tiles = doc.pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
      expect(tiles.length).toBeGreaterThan(0);
      expect(JSON.stringify(doc), 'the tagged text reaches the document').toContain(' zq');
      expect(JSON.stringify(tiles.map((t) => [t.label, t.figure.unavailable ?? null, t.delta?.basis ?? null]))).not.toContain('zq');
    } finally {
      warn.mockRestore();
    }
  });

  it('stampBlock measures a block set afterwards as printed, and stamps that text', () => {
    const doc = demoWithoutBudget();
    const block = doc.pages.flatMap((p) => p.blocks).find((b) => b.kind === 'table')!;
    const table = (block as Extract<PackPageBlock, { kind: 'table' }>).table;
    const given = { ...block, table: { ...table, rows: table.rows.map((r, i) => (i === 0 ? { ...r, label: 'Profit!\uFE0FTelecommunications' } : r)) } } as PackPageBlock;
    const stamped = stampBlock(given, doc.numberConvention.scale, 'portrait') as Extract<PackPageBlock, { kind: 'table' }>;
    expect(stamped.table.rows[0]!.label).toBe('Profit!Telecommunications');
  });
});
