/**
 * Financial years as stored records: no code outside the registry derives a year's
 * boundaries from the company's CURRENT `financial_year_start`.
 *
 * A year is a `fiscal_years` row (migration 940) read through
 * gl/fiscalYearRegistry. Rebuilding a year's dates from the declared start month
 * (`fiscalYearRange`, `fiscalYearStart`, `getFiscalYearStartMonth`, or an ad-hoc
 * `COALESCE(financial_year_start, 3)` / `financial_year_start || 3`) re-cuts every
 * historical year the moment the company changes its year end, and cannot express a
 * 14-month transition year at all.
 *
 * Every file under src/ and pages/ that still contains one of those spellings is
 * listed below, PER FILE, with why. The definitions are the pure calendar and the
 * basis helpers the registry's own template mirrors; the rest are payroll and budget
 * readers that convert in a later PR. A new file using any of them fails here, and so
 * does an allow-list entry whose file no longer does (it must be deleted, not kept).
 *
 * A source-text ratchet, not a behaviour test: the behaviour is pinned by
 * tests/integration (fiscal-years registry suites). Reads `git ls-files`, so a new
 * untracked file is not scanned until it is added.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');

/** A start-month derivation of a year's boundaries. Compared against source with comments removed. */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['fiscalYearRange(', /\bfiscalYearRange\(/],
  ['fiscalYearStart(', /\bfiscalYearStart\(/],
  ['getFiscalYearStartMonth', /\bgetFiscalYearStartMonth\b/],
  ['COALESCE(financial_year_start', /COALESCE\(\s*(?:\w+\.)?financial_year_start/i],
  // `|| <number>`: a fallback between two NAMES for the column (companyModel) is not a month default.
  ['financial_year_start ||', /\bfinancial_year_start\s*\|\|\s*\d/],
  ['financial_year_start as number) ||', /\bfinancial_year_start\s+as\s+number\)\s*\|\|\s*\d/],
];

/** file -> reason. Pinned per file: a second spelling in an allowed file is not a new decision. */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/modules/accounting/services/gl/fiscalYearCalendar.ts':
    'definition: fiscalYearRange, the pure calendar the generator and tests build a template year from',
  'src/modules/accounting/services/gl/fiscalYearBasis.ts':
    'definition: fiscalYearStart / getFiscalYearStartMonth, the declared-month helpers (payroll still reads them)',
};

/** Strip `//` and block comments so prose describing the old way is not a use of it. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

function files(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src', 'pages'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
}

/** The spellings of the forbidden derivations present in one source text. */
export function spellingsIn(src: string): string[] {
  const text = code(src);
  return FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const hits = files()
  .map((f) => ({ f, spellings: spellingsIn(readFileSync(resolve(ROOT, f), 'utf8')) }))
  .filter((h) => h.spellings.length > 0);

describe('fiscal-year boundaries come from the registry, never the current start month', () => {
  it('scans the source tree', () => {
    expect(files().length).toBeGreaterThan(1000);
  });

  it('no file outside the allow-list derives a year from financial_year_start', () => {
    const offenders = hits.filter((h) => !(h.f in ALLOWED)).map((h) => `${h.f}: ${h.spellings.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('no allow-list entry is stale', () => {
    const stale = Object.keys(ALLOWED).filter((f) => !hits.some((h) => h.f === f));
    expect(stale).toEqual([]);
  });

  it('every allow-list entry names a reason', () => {
    for (const [f, reason] of Object.entries(ALLOWED)) expect(reason.length, f).toBeGreaterThan(20);
  });
});

describe('the rule bites (planted spellings)', () => {
  it.each([
    ['fiscalYearRange(', 'const r = fiscalYearRange(2027, month);'],
    ['fiscalYearStart(', 'const s = fiscalYearStart(date, 3);'],
    ['getFiscalYearStartMonth', "import { getFiscalYearStartMonth } from './fiscalYearBasis';"],
    ['COALESCE(financial_year_start', 'SELECT COALESCE(financial_year_start, 3) FROM companies'],
    ['COALESCE(financial_year_start', 'SELECT COALESCE(c.financial_year_start, 3) AS m FROM companies c'],
    ['financial_year_start ||', 'const m = row.financial_year_start || 3;'],
    ['financial_year_start as number) ||', 'const m = (row.financial_year_start as number) || 3;'],
  ])('flags %s', (name, src) => {
    expect(spellingsIn(src)).toContain(name);
  });

  it('ignores prose in comments', () => {
    expect(spellingsIn('// it used to call fiscalYearRange(fy, month)\n/* fiscalYearStart( */\nconst x = 1;')).toEqual([]);
  });
});
