/**
 * South African number formats on a free-form budget sheet (MCP budget tools PR 2, after round 5): the exact-string
 * allowlist of rand currency and accounting formats the character rule refuses (quoted "R", [$R-1C09] / [$R-en-ZA] /
 * [$R-436], `\-`, the accounting zero `"-"??`), as LibreOffice writes them in xlsx for en-ZA (verified) and as Excel
 * writes them (Microsoft's en-ZA defaults, not verified from a real Excel file). Matched after whitespace is normalised,
 * a leading locale-only tag ([$-1C09], [$-436], [$-409]) dropped and colour names case-folded. Every accepted format
 * shows the imported value: a format with no decimals accepts whole rands only (it would show 1 235 for 1 234.50),
 * and the red-without-minus variants (a negative shown unsigned) stay refused.
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
    ['a locale tag that is not South Africa\'s or en-US\'s', '[$-407]"R "#,##0.00;"R-"#,##0.00'],
  ])('%s is refused', async (_n, code) => {
    expect(await cellWith(code, 12.5)).toEqual({ kind: 'error', raw: '12.5', reason: expect.stringMatching(/^This cell's number format/) });
  });

  it('a format with no decimals accepts whole rands only: it shows 1 235 for 1 234.50', async () => {
    expect(await cellWith('_-"R"* #,##0_-;\\-"R"* #,##0_-;_-"R"* "-"_-;_-@_-', 1234.5))
      .toEqual({ kind: 'error', raw: '1234.5', reason: 'This cell shows 0 decimal places but holds 1234.5, so what you see is not what would be imported; format it with 2 decimals.' });
    expect(await cellWith('#,##0', 83.33)).toMatchObject({ kind: 'error', reason: expect.stringMatching(/^This cell shows 0 decimal places but holds 83.33/) }); // the character rule's formats too
    expect(await cellWith('#,##0', 83)).toEqual({ kind: 'value', cents: 8300 });
  });

  it('a leading locale-only tag is dropped before matching (an Excel spelling resaved with LibreOffice\'s [$-1C09])', async () => {
    expect(await cellWith('[$-1C09]_-"R"* #,##0.00_-;\\-"R"* #,##0.00_-;_-"R"* "-"??_-;_-@_-', 12.5)).toEqual({ kind: 'value', cents: 1250 });
  });

  it('whitespace is normalised (a non-breaking space, two spaces) and colour names case-folded', async () => {
    expect(await cellWith('"R" #,##0.00;[RED]\\-"R"  #,##0.00', -5)).toEqual({ kind: 'value', cents: -500 });
  });
});
