/**
 * Tax-table pin (wave-4 spec §4 O): tax year -> SHA-256 of the statutory figures the payroll
 * engine reads for that year:
 * - taxTables.ts: brackets, rebates, thresholds, medical credits, UIF ceiling, SDL threshold, s11F cap;
 * - the rates: UIF_RATE, SDL_RATE, RETIREMENT_DEDUCTION_RATE (27.5%), the s18A DONATION_LIMIT (5%);
 * - etiTables.ts / etiEngine.ts: the ETI table and its unconfirmed flag for each month of the year,
 *   the unconfirmed-table policy, the age band, the 24-month window and the first-year length.
 * NOT pinned here (still literals in code): the 65 / 75 rebate ages and the 33.3% / 3x additional
 * medical credit (payeEngine.ts), and the 12 periods a year (payeCumulative.ts).
 * Changing a pinned figure, or adding a tax year, without updating PINNED below is red. The oracle
 * (payrollOracle.test.ts) then shows which outside figures moved.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getTaxYearConfig, SUPPORTED_TAX_YEARS } from '@/modules/accounting/services/payroll/taxTables';
import {
  ETI_AFTER_MARCH_2026_POLICY, isEtiTableUnconfirmed, selectEtiTable, UnsupportedEtiPeriodError,
} from '@/modules/accounting/services/payroll/etiTables';
import {
  ETI_FIRST_YEAR_MONTHS, ETI_MAX_AGE, ETI_MIN_AGE, ETI_WINDOW_MONTHS,
} from '@/modules/accounting/services/payroll/etiEngine';
import { UIF_RATE } from '@/modules/accounting/services/payroll/uifEngine';
import { SDL_RATE } from '@/modules/accounting/services/payroll/sdlEngine';
import { RETIREMENT_DEDUCTION_RATE } from '@/modules/accounting/services/payroll/retirementFund';
import { DONATION_LIMIT } from '@/modules/accounting/services/payroll/s18aDonation';

/** Wave-5 spec decision 2 (Hein, 2026-11-08): the wave coordinator agent owns the annual SARS-table update; Hein signs it off. */
const TABLE_OWNER = 'the wave coordinator agent prepares the February tables PR that ~/bin/isaflow-tax-tables-cron.sh opens (cron 08:00, 20-28 Feb); Hein signs it off (wave-5 spec decision 2)';
const CRON = '~/bin/isaflow-tax-tables-cron.sh';

const PINNED: Record<number, string> = {
  2025: '52ecdd71eeee2ba2d3bcb81a9eff5725f97fbea365fbff6938bd8033442319d0',
  2026: '6d4dc1e69270af04759b1d8fd1f018040f1a138d181ab77a1d8489ab8e269c03',
  2027: 'ecce560856dd6c8eb82656483718af6aec08304e0e13d7a90dc81f9b34cecd8b',
};

/** JSON with sorted keys and Infinity spelled out, so the hash is stable and Infinity is not lost as null. */
function canonical(v: unknown): string {
  if (v === Infinity) return '"Infinity"';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function etiForTaxYear(taxYear: number): unknown[] {
  // March of taxYear - 1 to February of taxYear.
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(taxYear - 1, 2 + i, 1);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    try {
      return { month, table: selectEtiTable(d), unconfirmed: isEtiTableUnconfirmed(d) };
    } catch (err) {
      if (err instanceof UnsupportedEtiPeriodError) return { month, table: null };
      throw err;
    }
  });
}

function tableHash(taxYear: number): string {
  const payload = {
    tax: getTaxYearConfig(taxYear),
    rates: { uif: UIF_RATE, sdl: SDL_RATE, retirementDeduction: RETIREMENT_DEDUCTION_RATE, s18aDonationLimit: DONATION_LIMIT },
    eti: etiForTaxYear(taxYear),
    etiRules: {
      policy: ETI_AFTER_MARCH_2026_POLICY, minAge: ETI_MIN_AGE, maxAge: ETI_MAX_AGE,
      windowMonths: ETI_WINDOW_MONTHS, firstYearMonths: ETI_FIRST_YEAR_MONTHS,
    },
  };
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function checklist(year: number, what: string): string {
  return `Payroll tax tables for tax year ${year}: ${what}. This is the February SARS budget checklist: check every `
    + 'bracket, rebate, threshold, medical credit, the UIF ceiling, the SDL threshold, the s11F cap, the UIF and SDL rates, '
    + 'the 27.5% retirement and 5% s18A limits, and the ETI table, age band and window against SARS, then set '
    + `PINNED[${year}] in tests/unit/services/payroll/taxTableHash.test.ts and re-run payrollOracle.test.ts. `
    + `Table owner: ${TABLE_OWNER}. The ${CRON} cron's headless session opens a taxTables PR every February; `
    + 'that PR must update this pin.';
}

describe('tax-table hash pin', () => {
  it('pins exactly the tax years that have tables', () => {
    const years = [...SUPPORTED_TAX_YEARS];
    const pinned = Object.keys(PINNED).map(Number);
    const unpinned = years.filter(y => !(y in PINNED));
    expect(unpinned, unpinned.map(y => checklist(y, `added with no pin (sha256 ${tableHash(y)})`)).join('\n')).toEqual([]);
    expect(pinned.filter(y => !years.includes(y)), 'pinned years with no tables: remove the pin').toEqual([]);
  });

  it.each(Object.keys(PINNED).map(Number))('tax year %i matches its pin', (year) => {
    const actual = tableHash(year);
    expect(actual, checklist(year, `figures changed (sha256 ${actual}, pinned ${PINNED[year]})`)).toBe(PINNED[year]);
  });

  it('the canonical form keeps Infinity (the top bracket) and is key-order independent', () => {
    expect(canonical({ b: 1, a: [Infinity] })).toBe('{"a":["Infinity"],"b":1}');
    expect(canonical({ a: [Infinity], b: 1 })).toBe(canonical({ b: 1, a: [Infinity] }));
  });
});
