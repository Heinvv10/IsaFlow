/**
 * Which number formats a free-form budget sheet's money cells may carry, and how many decimals each shows (MCP
 * budget tools PR 2, after review round 5). Three sources, in order:
 * Before every check a locale-only tag ([$-1C09] en-ZA, [$-436] af-ZA, [$-409] en-US, [$-809], [$-407], any hex id and
 * no currency) is dropped from the start of each section (round 7, `stripLocaleTags`): LibreOffice writes one when the
 * format's Language is set (in the dialog, or by the locale the format was made in); it picks no digits.
 *  1. Excel's built-in plain formats by id (0 General, 1-4, 37-40, 41 and 43: no currency symbol), General by name, and
 *     Text (`@`, built-in 49; round 7): a number in a Text cell shows as General does.
 *  2. ZA_FORMATS: an EXACT-STRING allowlist of South African rand currency and accounting formats that the character
 *     rule refuses (they carry quoted or escaped text: "R", \-, the accounting zero "-"??). None changes a number's value
 *     or sign (a "-" for 0 is 0; a red negative keeps its minus; no scaling, no condition). Matched after `normaliseFormat`:
 *     the tags dropped, whitespace runs (a non-breaking space included) to one space, colour names case-folded.
 *  3. The character rule (`budgetFreeformXml.isPlainNumberFormat`).
 * A format shows `decimals` places for a value (`formatDecimals`; Infinity: General and Text): a cell holding more is
 * refused by the reader, but under a format showing exactly 2, where IsaFlow rounds it to cents and lists it
 * (`budgetFreeformAmounts`). The guarantee is the
 * value read, not how a spreadsheet draws it (round 8; evidence doc).
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
  // Round 7: the rand without a thousands separator. LibreOffice's en-ZA dialog with the separator off, and the codes
  // "R "0.00 / [$R-1C09]\ 0.00 / "R"0.00 / "R "0 typed in LibreOffice (as it writes them: "R"0.00 becomes \R0.00).
  { code: '[$R-1C09]\\ 0.00;[$R-1C09]\\-0.00', decimals: 2, source: LO }, { code: '[$R-1C09]\\ 0.00;[RED][$R-1C09]\\-0.00', decimals: 2, source: LO },
  { code: '[$R-1C09]\\ 0;[$R-1C09]\\-0', decimals: 0, source: LO }, { code: '[$R-1C09]\\ 0;[RED][$R-1C09]\\-0', decimals: 0, source: LO },
  { code: '[$-409]"R "0.00', decimals: 2, source: LOX }, { code: '[$R-1C09]\\ 0.00', decimals: 2, source: LOX },
  { code: '[$-409]\\R0.00', decimals: 2, source: LOX }, { code: '[$-409]"R "0', decimals: 0, source: LOX },
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
  // Round 7: the same without a thousands separator, as Excel spells them (quoted, or with a spaced [$R-1C09]).
  { code: '"R"0.00', decimals: 2, source: XL }, { code: '"R"0', decimals: 0, source: XL }, { code: '"R" 0.00', decimals: 2, source: XL },
  { code: '"R" 0.00;\\-"R" 0.00', decimals: 2, source: XL }, { code: '[$R-1C09] 0.00', decimals: 2, source: XL }, { code: '[$R-en-ZA] 0.00', decimals: 2, source: XL },
];

const COLOURS = /\[(black|red)\]/gi;
const LOCALE_TAG = /^((?:\[[a-z]+\])*)\[\$-[0-9a-f]{1,8}\]/i;
/** A format code with the locale-only tag at the start of each section (after any colour) dropped (round 7). */
export const stripLocaleTags = (code: string): string => code.split(';').map((section) => section.replace(LOCALE_TAG, '$1')).join(';');
/** A format code as the allowlist compares it. */
export const normaliseFormat = (code: string): string => stripLocaleTags(code).replace(/\s+/g, ' ').trim()
  .replace(COLOURS, (_m, c: string) => `[${c[0]!.toUpperCase()}${c.slice(1).toLowerCase()}]`);

const SAFE = new Map(ZA_FORMATS.map((f) => [normaliseFormat(f.code), f.decimals]));
/** Decimals the plain built-ins show (General and Text, 49, show what the value holds). */
const BUILTIN_DECIMALS: Readonly<Record<number, number>> = { 0: Infinity, 1: 0, 2: 2, 3: 0, 4: 2, 37: 0, 38: 0, 39: 2, 40: 2, 41: 0, 43: 2, 49: Infinity };

/**
 * The decimal places a money cell's format shows FOR ITS VALUE, or null when the format is not one a money cell may
 * carry. Round 9: the section that draws the value decides (Excel's rule): a negative is drawn by the second section
 * when there is one, zero by the third when there is one (zero has no fraction, so that section never matters), every
 * other value by the first. So `0.00;-0.0` shows 2 decimals for 1.25 and 1 for -1.25, and `#,##0.00;-#,##0.00;0` shows
 * 2 for 1.50. Every digit placeholder after the section's `.` counts, a literal between them or not.
 */
export function formatDecimals(id: number, raw: string | undefined, value = 0): number | null {
  if (raw === undefined) return BUILTIN_DECIMALS[id] ?? null;
  const code = stripLocaleTags(raw);
  if (/^\s*(?:general|@)\s*$/i.test(code)) return Infinity;
  const known = SAFE.get(normaliseFormat(code));
  if (known !== undefined) return known;
  if (!isPlainNumberFormat(id, code)) return null;
  const sections = code.split(';');
  const section = sections[value < 0 && sections.length >= 2 ? 1 : value === 0 && sections.length >= 3 ? 2 : 0]!;
  // Round 8: padding, fills and [...] codes are no placeholders (`0.00\ ?` draws 1.234 as "1.23 4": 3 decimals).
  const bare = section.replace(/_./gs, '').replace(/\*./gs, '').replace(/\[[^\]]*\]/g, '');
  const dot = bare.indexOf('.');
  return dot < 0 ? 0 : (bare.slice(dot + 1).match(/[0#?]/g) ?? []).length;
}
