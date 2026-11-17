/**
 * Which number formats a free-form budget sheet's money cells may carry, and how many decimals each shows (MCP
 * budget tools PR 2, after review round 5). Three sources, in order:
 *  1. Excel's built-in plain formats by id (0 General, 1-4, 37-40, 41 and 43: no currency symbol).
 *  2. ZA_FORMATS: an EXACT-STRING allowlist of South African rand currency and accounting formats that the character
 *     rule refuses (they carry quoted or escaped text: "R", \-, the accounting zero "-"??). Each shows the imported
 *     value for every number (a "-" for 0 imports 0; a red negative keeps its minus). Matched after `normaliseFormat`:
 *     whitespace runs (a non-breaking space included) to one space, a LEADING locale-only tag dropped ([$-1C09] en-ZA,
 *     [$-436] af-ZA, [$-409] en-US: LibreOffice prefixes the format's locale; a locale picks no digits), colour names
 *     case-folded ([RED] = [Red]).
 *  3. The character rule (`budgetFreeformXml.isPlainNumberFormat`).
 * A format shows `decimals` places: a cell holding more is refused by the reader (it would show 1 235 for 1 234.50).
 *
 * Sources of ZA_FORMATS (evidence doc, "South African formats"): `libreoffice` = LibreOffice 24.2's own en-ZA
 * currency formats, applied to a cell and read back from the xlsx it saved; `libreoffice-excel` = Excel's en-ZA
 * strings as LibreOffice writes them in xlsx (added in Excel syntax, read back); `excel` = Excel's en-ZA defaults as
 * Microsoft documents them, NOT verified from a file saved by Excel (no Excel on this box).
 */
import { isPlainNumberFormat } from './budgetFreeformXml';

export interface ZaFormat { code: string; decimals: 0 | 2; source: 'libreoffice' | 'libreoffice-excel' | 'excel' }

const LO = 'libreoffice' as const, LOX = 'libreoffice-excel' as const, XL = 'excel' as const;
const accounting = (sym: string, zero2: string, zero0: string, src: ZaFormat['source']): ZaFormat[] => [
  { code: `_-${sym}* #,##0.00_-;\\-${sym}* #,##0.00_-;_-${sym}* ${zero2}_-;_-@_-`, decimals: 2, source: src },
  { code: `_-${sym}* #,##0_-;\\-${sym}* #,##0_-;_-${sym}* ${zero0}_-;_-@_-`, decimals: 0, source: src },
];

export const ZA_FORMATS: readonly ZaFormat[] = [
  // LibreOffice's own en-ZA currency formats (its xlsx spelling).
  { code: '[$-1C09]"R "#,##0;"R-"#,##0', decimals: 0, source: LO },
  { code: '[$-1C09]"R "#,##0.00;"R-"#,##0.00', decimals: 2, source: LO },
  { code: '[$-1C09]"R "#,##0;[RED]"R-"#,##0', decimals: 0, source: LO },
  { code: '[$-1C09]"R "#,##0.00;[RED]"R-"#,##0.00', decimals: 2, source: LO },
  { code: '[$R-1C09]\\ #,##0;[$R-1C09]\\-#,##0', decimals: 0, source: LO },
  { code: '[$R-1C09]\\ #,##0.00;[$R-1C09]\\-#,##0.00', decimals: 2, source: LO },
  { code: '[$R-1C09]\\ #,##0;[RED][$R-1C09]\\-#,##0', decimals: 0, source: LO },
  { code: '[$R-1C09]\\ #,##0.00;[RED][$R-1C09]\\-#,##0.00', decimals: 2, source: LO },
  // Excel's en-ZA strings as LibreOffice writes them.
  { code: '[$-409]_-\\R* #,##0.00_-;"-R"* #,##0.00_-;_-\\R* \\-??_-;_-@_-', decimals: 2, source: LOX },
  { code: '[$-409]_-\\R* #,##0_-;"-R"* #,##0_-;_-\\R* \\-_-;_-@_-', decimals: 0, source: LOX },
  { code: '[$-409]_-* #,##0.00_-;\\-* #,##0.00_-;_-* \\-??_-;_-@_-', decimals: 2, source: LOX },
  { code: '[$-409]_-* #,##0_-;\\-* #,##0_-;_-* \\-_-;_-@_-', decimals: 0, source: LOX },
  { code: '[$-409]\\R#,##0.00', decimals: 2, source: LOX },
  { code: '[$-409]\\R#,##0', decimals: 0, source: LOX },
  { code: '[$-409]\\R#,##0.00;"-R"#,##0.00', decimals: 2, source: LOX },
  { code: '[$-409]\\R#,##0;"-R"#,##0', decimals: 0, source: LOX },
  { code: '[$-409]\\R#,##0.00;[RED]"-R"#,##0.00', decimals: 2, source: LOX },
  { code: '[$-409]\\R#,##0;[RED]"-R"#,##0', decimals: 0, source: LOX },
  { code: '[$-409]"R "#,##0.00', decimals: 2, source: LOX },
  { code: '[$-409]"R "#,##0.00;"-R "#,##0.00', decimals: 2, source: LOX },
  { code: '[$-409]"R "#,##0.00;[RED]"-R "#,##0.00', decimals: 2, source: LOX },
  { code: '[$R-en-ZA]\\ #,##0.00', decimals: 2, source: LOX },
  { code: '[$R-1C09]\\ #,##0.00', decimals: 2, source: LOX },
  { code: '[$R-436]\\ #,##0.00', decimals: 2, source: LOX },
  { code: '[$R-1C09]#,##0.00;\\-[$R-1C09]#,##0.00', decimals: 2, source: LOX },
  { code: '_-[$R-1C09]* #,##0.00_-;\\-[$R-1C09]* #,##0.00_-;_-[$R-1C09]* \\-??_-;_-@_-', decimals: 2, source: LOX },
  { code: '_-[$R-en-ZA]* #,##0.00_-;\\-[$R-en-ZA]* #,##0.00_-;_-[$R-en-ZA]* \\-??_-;_-@_-', decimals: 2, source: LOX },
  { code: '_-[$R-436]* #,##0.00_-;\\-[$R-436]* #,##0.00_-;_-[$R-436]* \\-??_-;_-@_-', decimals: 2, source: LOX },
  // Excel's en-ZA defaults as Microsoft documents them (accounting with and without R, currency, built-ins 41 / 43 as
  // en-ZA files spell them): not verified from a file Excel saved.
  ...accounting('"R"', '"-"??', '"-"', XL),
  ...accounting('', '"-"??', '"-"', XL),
  ...accounting('[$R-en-ZA]', '"-"??', '"-"', XL), ...accounting('[$R-1C09]', '"-"??', '"-"', XL), ...accounting('[$R-436]', '"-"??', '"-"', XL),
  { code: '"R"#,##0.00', decimals: 2, source: XL }, { code: '"R"#,##0', decimals: 0, source: XL },
  { code: '"R"#,##0.00;\\-"R"#,##0.00', decimals: 2, source: XL }, { code: '"R"#,##0;\\-"R"#,##0', decimals: 0, source: XL },
  { code: '"R"#,##0.00;[Red]\\-"R"#,##0.00', decimals: 2, source: XL }, { code: '"R"#,##0;[Red]\\-"R"#,##0', decimals: 0, source: XL },
  { code: '"R" #,##0.00', decimals: 2, source: XL }, { code: '"R" #,##0.00;\\-"R" #,##0.00', decimals: 2, source: XL },
  { code: '"R" #,##0.00;[Red]\\-"R" #,##0.00', decimals: 2, source: XL },
  { code: '[$R-en-ZA] #,##0.00', decimals: 2, source: XL }, { code: '[$R-1C09] #,##0.00', decimals: 2, source: XL }, { code: '[$R-436] #,##0.00', decimals: 2, source: XL },
  { code: '[$R-en-ZA] #,##0.00;\\-[$R-en-ZA] #,##0.00', decimals: 2, source: XL },
];

const COLOURS = /\[(black|blue|cyan|green|magenta|red|white|yellow)\]/gi;
/** A format code as the allowlist compares it. */
export const normaliseFormat = (code: string): string => code.replace(/\s+/g, ' ').trim().replace(/^\[\$-(?:1C09|436|409)\]/i, '')
  .replace(COLOURS, (_m, c: string) => `[${c[0]!.toUpperCase()}${c.slice(1).toLowerCase()}]`);

const SAFE = new Map(ZA_FORMATS.map((f) => [normaliseFormat(f.code), f.decimals]));
/** Decimals the plain built-ins show (General shows what the value holds). */
const BUILTIN_DECIMALS: Readonly<Record<number, number>> = { 0: Infinity, 1: 0, 2: 2, 3: 0, 4: 2, 37: 0, 38: 0, 39: 2, 40: 2, 41: 0, 43: 2 };

/** The decimal places a money cell's format shows, or null when the format is not one a money cell may carry. */
export function formatDecimals(id: number, code: string | undefined): number | null {
  if (code === undefined) return BUILTIN_DECIMALS[id] ?? null;
  if (/^\s*general\s*$/i.test(code)) return Infinity;
  const known = SAFE.get(normaliseFormat(code));
  if (known !== undefined) return known;
  if (!isPlainNumberFormat(id, code)) return null;
  const shown = code.split(';').slice(0, 3).map((section) => /\.([0#?]*)/.exec(section.replace(/[_*]./gs, ''))?.[1]?.length ?? 0);
  return Math.min(...shown);
}
