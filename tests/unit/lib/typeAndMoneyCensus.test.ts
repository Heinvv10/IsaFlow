/**
 * Type scale, money and date display census (master plan 3b, "type and money").
 *
 * The app has ONE type scale (tailwind.config.mjs: xs 12, sm 14, base 16, lg 18, xl 20, 2xl 24 px;
 * 12 px is the floor), ONE money format (src/lib/money/formatMoney.ts: "R 25 000.00") and ONE date
 * format (src/utils/dateFormat.ts: "21 Oct 2026"). This reads the working tree (tracked AND untracked
 * files, so a new file cannot slip past before it is added) and fails on a screen file that:
 *   1. sets a font size off the scale (text-[10px], text-[13px], fontSize: 10, fontSize: '0.9rem');
 *   2. uses a display size (text-3xl and up) outside the marketing, legal, sign-in and slide surfaces;
 *   3. puts font-mono on a money or numeric cell;
 *   4. formats money by hand: Intl.NumberFormat('en-ZA'), toLocaleString with fraction digits or a
 *      currency, "R" glued to toFixed/toLocaleString, a template or a "R " string concatenation;
 *   5. formats a date by hand: toLocaleDateString, toLocaleTimeString, a Date's toLocaleString, a
 *      toLocaleString with date options, or an ISO date shown raw (x.split('T')[0] in JSX).
 * Screen files are src/** and pages/** .ts/.tsx except pages/api, src/lib and the .ts services under
 * src/modules (server code keeps its own, machine, formats). Allowlists only shrink: an entry whose
 * file no longer needs it fails the test. Not seen: a size or format built at runtime.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const ROOT = process.cwd();
const listed = (...dirs: string[]): string[] =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...dirs], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\n').filter(Boolean);

const SCREEN_FILES = listed('src', 'pages').filter(
  (f) => /\.tsx?$/.test(f)
    && !f.startsWith('pages/api/') && !f.startsWith('src/lib/')
    && !(f.startsWith('src/modules/') && !f.endsWith('.tsx'))
    && f !== 'src/utils/dateFormat.ts',
);
const read = (f: string): string => readFileSync(`${ROOT}/${f}`, 'utf8');
const lines = (f: string): string[] => read(f).split('\n');
const eachLine = (test: (line: string) => string[]): string[] =>
  SCREEN_FILES.flatMap((f) => lines(f).flatMap((l, i) => test(l).map((hit) => `${f}:${i + 1} ${hit}`)));

const SCALE_PX = new Set([12, 14, 16, 18, 20, 24]);
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

export function offScale(line: string): string[] {
  const hits: string[] = [];
  const px = (n: string, unit: string): number => Number(n) * (unit === 'rem' ? 16 : 1);
  // 30 px and up is a display size: policed by the display-size rule below, not by the scale.
  for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
    const size = px(m[1] ?? '', m[2] ?? 'px');
    if (!SCALE_PX.has(size) && size < 30) hits.push(m[0]);
  }
  for (const m of line.matchAll(/fontSize:\s*(?:(\d+(?:\.\d+)?)|'(\d+(?:\.\d+)?)(px|rem)')(?![\d.]|\s*[+*])/g)) {
    const value = m[1] !== undefined ? Number(m[1]) : px(m[2] ?? '', m[3] ?? 'px');
    if (!SCALE_PX.has(value) && value < 30) hits.push(m[0]);
  }
  return hits;
}

const CLOSE = /<\/(?:td|span|p|div|code|dd|li|strong|kbd|th)>/;
const MONEY_CALL =
  /\bfmt[A-Za-z]*\(|formatMoney|formatCurrency|formatAmount|formatRand|<Money\b|formatCents|\.toFixed\(|formatZar|\bzar\(|Intl\.NumberFormat|\.toLocaleString\(/;
const CODE_LIKE = /<code|<kbd|<pre|break-all|select-all/;

/** font-mono on an element that shows a number: a money call in its first three lines, or a right-aligned cell. */
export function monoOnNumber(all: string[], i: number): boolean {
  const line = all[i] ?? '';
  if (!/\bfont-mono\b/.test(line) || CODE_LIKE.test(line)) return false;
  let win = all.slice(i, i + 3).join('\n');
  const cut = CLOSE.exec(win);
  if (cut) win = win.slice(0, cut.index);
  return MONEY_CALL.test(win) || /\btext-right\b/.test(line);
}

const MONEY_DIGITS = /\.toLocaleString\([^)]*(?:FractionDigits|currency|style)/;
const R_GLUED = /(?:^|[^\w])R ?(?:\$|\{)\{?[^}]*\.(?:toFixed|toLocaleString)\(|(?:^|[^\w])R\$\{|['"`]R ?['"`]\s*\+/;
export function handMadeMoney(line: string): string[] {
  const hits: string[] = [];
  if (MONEY_DIGITS.test(line)) hits.push('toLocaleString money');
  if (R_GLUED.test(line)) hits.push('"R" glued to a number');
  return hits;
}

const DATE_OPTS = /dateStyle|timeStyle|month|year|hour|minute|timeZone|weekday/;
export function handMadeDate(line: string): string[] {
  const hits: string[] = [];
  if (/\.toLocaleDateString\(|\.toLocaleTimeString\(/.test(line)) hits.push('toLocale{Date,Time}String');
  if (/new Date\([^)]*\)\.toLocaleString\(/.test(line)) hits.push("new Date().toLocaleString");
  for (const m of line.matchAll(/\.toLocaleString\(([^)]*)\)/g)) {
    if (DATE_OPTS.test(m[1] ?? '')) hits.push('toLocaleString with date options');
  }
  if (/>\s*\{\s*[\w.?!]+\??\.(?:split\('T'\)\[0\]|slice\(0, ?10\))\s*\}/.test(line) || /value: [\w.?!]+\??\.(?:split\('T'\)\[0\]|slice\(0, ?10\))/.test(line)) {
    hits.push('ISO date shown raw');
  }
  return hits;
}

describe('type scale: only the six sizes', () => {
  it('has no font size off the scale in a screen file', () => {
    const found = SCREEN_FILES.filter((f) => !PACK_CHART_FONTS.has(f)).flatMap((f) =>
      lines(f).flatMap((l, i) => offScale(l).map((hit) => `${f}:${i + 1} ${hit}`)));
    expect(found).toEqual([]);
  });

  it('keeps no pack-chart allowlist entry that no longer needs it', () => {
    const stale = [...PACK_CHART_FONTS].filter((f) => !lines(f).some((l) => offScale(l).length > 0));
    expect(stale).toEqual([]);
  });

  it('flags the shapes it is meant to flag', () => {
    expect(offScale('<p className="text-[10px]">')).toEqual(['text-[10px]']);
    expect(offScale('<p className="text-[13px] md:text-[11px]">')).toEqual(['text-[13px]', 'text-[11px]']);
    expect(offScale('<p className="text-[0.6rem]">')).toEqual(['text-[0.6rem]']);
    expect(offScale('tick={{ fontSize: 10 }}')).toEqual(['fontSize: 10']);
    expect(offScale("style={{ fontSize: '0.9rem' }}")).toEqual(["fontSize: '0.9rem'"]);
    expect(offScale('<p className="text-[12px] text-[1rem]">')).toEqual([]);
    expect(offScale("style={{ fontSize: '0.875rem' }} tick={{ fontSize: 12 }}")).toEqual([]);
  });
});

describe('type scale: display sizes stay on marketing surfaces', () => {
  const allowed = (f: string): boolean => DISPLAY_SIZE_FILES.has(f) || DISPLAY_SIZE_DIRS.some((d) => f.startsWith(d));

  it('has no text-3xl or larger in an app screen', () => {
    expect(SCREEN_FILES.filter((f) => !allowed(f) && DISPLAY.test(read(f)))).toEqual([]);
  });

  it('keeps no allowlisted file that no longer uses a display size', () => {
    expect([...DISPLAY_SIZE_FILES].filter((f) => !DISPLAY.test(read(f)))).toEqual([]);
  });
});

describe('money display', () => {
  it('has no font-mono on a money or numeric cell', () => {
    const found: string[] = [];
    for (const f of SCREEN_FILES.filter((x) => x.endsWith('.tsx'))) {
      const all = lines(f);
      all.forEach((_, i) => { if (monoOnNumber(all, i)) found.push(`${f}:${i + 1}`); });
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
    const found = SCREEN_FILES.filter((f) => !INTL_ALLOWED.has(f) && /Intl\.NumberFormat\(\s*'en-ZA'/.test(read(f)));
    expect(found).toEqual([]);
  });

  it('keeps no Intl allowlist entry that no longer needs it', () => {
    expect([...INTL_ALLOWED.keys()].filter((f) => !/Intl\.NumberFormat\(/.test(read(f)))).toEqual([]);
  });

  it('has no hand-made money: toLocaleString with fraction digits or "R" glued to a number', () => {
    expect(eachLine(handMadeMoney)).toEqual([]);
  });

  it('flags each hand-made money shape', () => {
    expect(handMadeMoney("x.toLocaleString('en-ZA', { minimumFractionDigits: 2 })")).toHaveLength(1);
    expect(handMadeMoney('<td>R{r.value.toFixed(2)}</td>')).toHaveLength(1);
    expect(handMadeMoney('`R ${(n / 1000).toFixed(0)}k`')).toHaveLength(1);
    expect(handMadeMoney('`R${total}`')).toHaveLength(1);
    expect(handMadeMoney("return 'R ' + abs;")).toHaveLength(1);
    expect(handMadeMoney('(R{r.totalAmount.toLocaleString()})')).toHaveLength(1);
    expect(handMadeMoney('{formatMoney(r.value)} and {total.toLocaleString()} rows')).toEqual([]);
  });
});

describe('date display', () => {
  it('has no hand-made date: toLocale{Date,Time}String, date options, or a raw ISO date', () => {
    expect(eachLine(handMadeDate)).toEqual([]);
  });

  it('flags each hand-made date shape', () => {
    expect(handMadeDate("d.toLocaleDateString('en-ZA')")).toHaveLength(1);
    expect(handMadeDate('d.toLocaleTimeString()')).toHaveLength(1);
    expect(handMadeDate('new Date(x).toLocaleString()')).toHaveLength(1);
    expect(handMadeDate("v.toLocaleString('en-ZA', { dateStyle: 'short' })")).toHaveLength(1);
    expect(handMadeDate('<td>{r.invoiceDate?.split(\'T\')[0]}</td>')).toHaveLength(1);
    expect(handMadeDate("{ label: 'Due', value: inv.due_date?.slice(0, 10) }")).toHaveLength(1);
    expect(handMadeDate("{count.toLocaleString('en-ZA')} rows, form: setForm({ d: x.split('T')[0] })")).toEqual([]);
  });
});
