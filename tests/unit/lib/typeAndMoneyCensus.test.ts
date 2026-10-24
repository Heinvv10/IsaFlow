/**
 * Type scale and money display census (master plan 3b, "type and money").
 *
 * The app has ONE type scale (tailwind.config.mjs: xs 12, sm 14, base 16, lg 18, xl 20, 2xl 24 px;
 * 12 px is the floor) and ONE money format (src/lib/money/formatMoney.ts: "R 25 000.00"). This reads
 * the tracked tree (git ls-files) and fails closed on:
 *   1. a font size below 12 px (text-[10px], text-[0.6rem], fontSize: 10 on a chart tick);
 *   2. a display size (text-3xl and up) outside the marketing, legal, sign-in and slide surfaces;
 *   3. font-mono on a money or numeric cell (amounts are DM Sans with tabular-nums);
 *   4. a page-local Intl.NumberFormat('en-ZA') money formatter (it prints "R 25 000,00");
 *   5. a date shown through toLocaleDateString with no options ("2026/10/21").
 *
 * Every allowlist below only shrinks: an entry whose file no longer needs it fails the test, so
 * fixing a file removes the entry. Not seen: a size built at runtime, or font-mono added through a
 * variable class name.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const ROOT = process.cwd();
const tracked = (...dirs: string[]): string[] =>
  execFileSync('git', ['ls-files', ...dirs], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

const SCREEN_FILES = tracked('src', 'pages').filter(
  (f) => /\.tsx?$/.test(f) && !f.startsWith('pages/api/') && !f.startsWith('src/modules/'),
);
const text = (f: string): string => readFileSync(`${ROOT}/${f}`, 'utf8');
const lines = (f: string): string[] => text(f).split('\n');

/** Display sizes (text-3xl and up) are for these surfaces only. Shrink-only. */
const DISPLAY_SIZE_FILES = new Set<string>([
  'src/components/auth/LoginBrandPanel.tsx',
  'src/components/accounting/packs/PackCover.tsx',
  'pages/contact.tsx',
]);
const DISPLAY_SIZE_DIRS = ['src/components/landing/', 'src/components/legal/', 'src/components/accounting/present/'];
const DISPLAY = /\btext-(?:[3-9]xl|\[(?:\d+(?:\.\d+)?)rem\])/;

/** Chart options shared with the board-pack renderer, whose label widths are measured at these sizes. Shrink-only. */
const PACK_CHART_FONTS = new Set<string>([
  'src/components/accounting/charts/bulletOption.ts',
  'src/components/accounting/charts/sankeyOption.ts',
  'src/components/accounting/charts/smallMultiplesOption.ts',
  'src/components/accounting/charts/waterfallOption.ts',
]);

/** Money display exceptions: multi-currency or non-money Intl use. Shrink-only. */
const INTL_ALLOWED = new Map<string, string>([
  ['pages/accounting/item-adjustments.tsx', 'a quantity, not money'],
  ['pages/portal/invoice/[token].tsx', 'a non-ZAR invoice currency'],
  ['src/components/accounting/group/IntercompanyShared.tsx', 'the intercompany currency is a parameter'],
  ['src/components/admin/ConvertTrialModal.tsx', 'a plan price in the plan currency'],
]);

const CLOSE = /<\/(?:td|span|p|div|code|dd|li|strong|kbd|th)>/;
const MONEY_CALL =
  /\bfmt[A-Za-z]*\(|formatMoney|formatCurrency|formatAmount|formatRand|<Money\b|formatCents|\.toFixed\(|formatZar|\bzar\(|Intl\.NumberFormat|\.toLocaleString\(/;
const CODE_LIKE = /<code|<kbd|<pre|break-all|select-all/;

export function belowTwelve(line: string): string[] {
  const hits: string[] = [];
  for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const px = Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
    if (px < 12) hits.push(m[0]);
  }
  for (const m of line.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)\b(?!\s*\+|\s*\*)/g)) {
    if (Number(m[1]) < 12) hits.push(m[0]);
  }
  return hits;
}

/** font-mono on an element that shows a number: a money call in its first three lines, or a right-aligned cell. */
export function monoOnNumber(all: string[], i: number): boolean {
  const line = all[i] ?? '';
  if (!/\bfont-mono\b/.test(line) || CODE_LIKE.test(line)) return false;
  let win = all.slice(i, i + 3).join('\n');
  const cut = CLOSE.exec(win);
  if (cut) win = win.slice(0, cut.index);
  return MONEY_CALL.test(win) || /\btext-right\b/.test(line);
}

describe('type scale: nothing below 12 px', () => {
  it('has no text-[Npx] / fontSize under 12 in a screen file', () => {
    const found: string[] = [];
    for (const f of SCREEN_FILES.filter((x) => !PACK_CHART_FONTS.has(x))) {
      lines(f).forEach((l, i) => {
        for (const hit of belowTwelve(l)) found.push(`${f}:${i + 1} ${hit}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('keeps no pack-chart allowlist entry that no longer needs it', () => {
    const stale = [...PACK_CHART_FONTS].filter((f) => !lines(f).some((l) => belowTwelve(l).length > 0));
    expect(stale).toEqual([]);
  });

  it('flags the shapes it is meant to flag', () => {
    expect(belowTwelve('<p className="text-[10px]">')).toEqual(['text-[10px]']);
    expect(belowTwelve('<p className="text-[11px] md:text-[13px]">')).toEqual(['text-[11px]']);
    expect(belowTwelve('<p className="text-[0.6rem]">')).toEqual(['text-[0.6rem]']);
    expect(belowTwelve('tick={{ fontSize: 10 }}')).toEqual(['fontSize: 10']);
    expect(belowTwelve('<p className="text-[12px] text-xs">')).toEqual([]);
    expect(belowTwelve('tick={{ fontSize: 12 }}')).toEqual([]);
  });
});

describe('type scale: display sizes stay on marketing surfaces', () => {
  const allowed = (f: string): boolean => DISPLAY_SIZE_FILES.has(f) || DISPLAY_SIZE_DIRS.some((d) => f.startsWith(d));

  it('has no text-3xl or larger in an app screen', () => {
    const found = SCREEN_FILES.filter((f) => !allowed(f) && DISPLAY.test(text(f)));
    expect(found).toEqual([]);
  });

  it('keeps no allowlisted file that no longer uses a display size', () => {
    const stale = [...DISPLAY_SIZE_FILES].filter((f) => !DISPLAY.test(text(f)));
    expect(stale).toEqual([]);
  });
});

describe('money display', () => {
  it('has no font-mono on a money or numeric cell', () => {
    const found: string[] = [];
    for (const f of SCREEN_FILES.filter((x) => x.endsWith('.tsx'))) {
      const all = lines(f);
      all.forEach((_, i) => {
        if (monoOnNumber(all, i)) found.push(`${f}:${i + 1}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('recognises a mono money cell and leaves an identifier alone', () => {
    expect(monoOnNumber(['<td className="text-right font-mono">{fmt(x)}</td>'], 0)).toBe(true);
    expect(monoOnNumber(['<td className="font-mono">', '{formatMoney(x)}', '</td>'], 0)).toBe(true);
    expect(monoOnNumber(['<td className="font-mono">{row.invoiceNumber}</td>'], 0)).toBe(false);
    expect(monoOnNumber(['<code className="font-mono">{fmt(x)}</code>'], 0)).toBe(false);
    expect(monoOnNumber(['<td className="tabular-nums text-right">{fmt(x)}</td>'], 0)).toBe(false);
  });

  it('has no page-local Intl.NumberFormat("en-ZA") formatter', () => {
    const found = SCREEN_FILES.filter(
      (f) => !f.startsWith('src/lib/') && !INTL_ALLOWED.has(f) && /Intl\.NumberFormat\(\s*'en-ZA'/.test(text(f)),
    );
    expect(found).toEqual([]);
  });

  it('keeps no Intl allowlist entry that no longer needs it', () => {
    const stale = [...INTL_ALLOWED.keys()].filter((f) => !/Intl\.NumberFormat\(/.test(text(f)));
    expect(stale).toEqual([]);
  });
});

describe('date display', () => {
  it('has no toLocaleDateString with no options ("2026/10/21")', () => {
    const found = SCREEN_FILES.filter((f) => /toLocaleDateString\(\s*(?:'en-ZA'|LOCALE)?\s*\)/.test(text(f)));
    expect(found).toEqual([]);
  });
});
