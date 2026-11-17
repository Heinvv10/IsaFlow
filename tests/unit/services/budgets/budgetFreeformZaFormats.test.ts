/**
 * South African number formats on a free-form budget sheet (MCP budget tools PR 2, after round 5): the exact-string
 * allowlist of rand currency and accounting formats the character rule refuses (quoted "R", [$R-1C09] / [$R-en-ZA] /
 * [$R-436], `\-`, the accounting zero `"-"??`), as LibreOffice writes them in xlsx for en-ZA (verified) and as Excel
 * writes them (Microsoft's en-ZA defaults, not verified from a real Excel file). Matched after whitespace is normalised,
 * a leading locale-only tag (any hex id, round 7) dropped and colour names case-folded. No accepted format changes
 * a value or its sign: a format with no decimals accepts whole rands only (IsaFlow rounds only under 2 decimals), and
 * the red-without-minus variants (a negative drawn unsigned) stay refused.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { readImportWorkbook } from '@/modules/accounting/services/budgets/budgetImportFreeformRead';
import { freeformLines } from '@/modules/accounting/services/budgets/budgetImportFreeform';
import { ZA_FORMATS } from '@/modules/accounting/services/budgets/budgetFreeformFormats';
import { MONTHS, model } from '../../mcp/budgetToolsFixture';
import { rawBook, rowXml, sheetBody, stylesWith } from './rawXlsxFixture';

async function cellWith(code: string, value: number) {
  const buf = await rawBook({ sheets: [{ name: 'Budget', body: sheetBody(rowXml(1, ['Code', ...MONTHS]) + rowXml(2, ['6000', { n: value, s: 1 }])) }], activeTab: 0, styles: stylesWith([0, 164], { 164: code }) });
  const r = await readImportWorkbook(buf);
  if (r.kind !== 'freeform') throw new Error('not free-form');
  return freeformLines(model(), 'company', r.sheet).lines[0]!.amounts[0]!.cell;
}

describe('every allowlisted en-ZA format is accepted, and its value read', () => {
  it.each(ZA_FORMATS.map((f) => [f.code, f.source, f.decimals] as const))('%s (%s)', async (code, _source, decimals) => {
    const value = decimals === 2 ? -1234.5 : -1234;
    expect(await cellWith(code, value)).toEqual({ kind: 'value', cents: Math.round(value * 100) });
    expect(await cellWith(code, 0)).toEqual({ kind: 'value', cents: 0 }); // an accounting "-" for 0 imports 0
  });
});

describe('what the allowlist keeps out', () => {
  it.each([
    ['Excel\'s red without a minus (a negative shown unsigned)', '"R"#,##0.00;[Red]"R"#,##0.00'],
    ['LibreOffice\'s red without a minus', '[$-409]\\R#,##0.00;[RED]\\R#,##0.00'],
    ['LibreOffice\'s "--" cents (Excel shows the amount rounded)', '[$-1C09]"R "#,##0.--;[RED]"R-"#,##0.--'],
    ['LibreOffice\'s ISO-code format (Excel cannot show "CCC")', '[$-1C09]#,##0.00\\ CCC'],
    ['an allowlisted format with another currency', '_-"$"* #,##0.00_-;\\-"$"* #,##0.00_-;_-"$"* "-"??_-;_-@_-'],
  ])('%s is refused', async (_n, code) => {
    expect(await cellWith(code, 12.5)).toEqual({ kind: 'error', raw: '12.5', reason: expect.stringMatching(/^This cell's number format/) });
  });

  it('a format with no decimals accepts whole rands only: it shows 1 235 for 1 234.50', async () => {
    expect(await cellWith('_-"R"* #,##0_-;\\-"R"* #,##0_-;_-"R"* "-"_-;_-@_-', 1234.5))
      .toEqual({ kind: 'error', raw: '1234.5', reason: 'This cell shows 0 decimal places but holds 1234.5; IsaFlow rounds to cents only under a format showing exactly 2 decimals, so format it with 2 decimals or round it in the sheet.' });
    expect(await cellWith('#,##0', 83.33)).toMatchObject({ kind: 'error', reason: expect.stringMatching(/^This cell shows 0 decimal places but holds 83.33/) }); // the character rule's formats too
    expect(await cellWith('#,##0', 83)).toEqual({ kind: 'value', cents: 8300 });
  });

  it('a leading locale-only tag is dropped before matching (an Excel spelling resaved with LibreOffice\'s [$-1C09])', async () => {
    expect(await cellWith('[$-1C09]_-"R"* #,##0.00_-;\\-"R"* #,##0.00_-;_-"R"* "-"??_-;_-@_-', 12.5)).toEqual({ kind: 'value', cents: 1250 });
  });

  it('round 7: ANY locale-only tag is dropped (a Language set in the dialog: [$-407] German, [$-809] en-GB), at the start of each section', async () => {
    expect(await cellWith('[$-407]"R "#,##0.00;"R-"#,##0.00', -12.5)).toEqual({ kind: 'value', cents: -1250 });
    expect(await cellWith('[$-809]#,##0.00;[RED][$-809]\\-#,##0.00', -12.5)).toEqual({ kind: 'value', cents: -1250 });
    expect(await cellWith('[$-1C09]@', 12.5)).toEqual({ kind: 'value', cents: 1250 }); // Text: shown as General
    expect(await cellWith('[$R-1C09]\\ 0.00;[$R-1C09]\\-0.00', -12.5)).toEqual({ kind: 'value', cents: -1250 }); // a currency tag is not one
  });

  it('whitespace is normalised (a non-breaking space, two spaces) and colour names case-folded', async () => {
    expect(await cellWith('"R" #,##0.00;[RED]\\-"R"  #,##0.00', -5)).toEqual({ kind: 'value', cents: -500 });
  });
});
