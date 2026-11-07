/**
 * Tax-table pin (wave-4 spec §4 O): tax year -> SHA-256 of every statutory figure the payroll
 * engine reads for that year: brackets, rebates, thresholds, medical credits, UIF ceiling, SDL
 * threshold, the s11F retirement cap (taxTables.ts), and the ETI tables and policy in force in
 * each month of the year (etiTables.ts). Changing any figure, or adding a year, without updating
 * PINNED below is red. The oracle (payrollOracle.test.ts) then shows which outside figures moved.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getTaxYearConfig, UnsupportedTaxYearError } from '@/modules/accounting/services/payroll/taxTables';
import {
  ETI_AFTER_MARCH_2026_POLICY, isEtiTableUnconfirmed, selectEtiTable, UnsupportedEtiPeriodError,
} from '@/modules/accounting/services/payroll/etiTables';

/** Decision 2 of the wave-4 spec: Hein names the annual SARS-table owner before W3 (suggested: Willie). */
const TABLE_OWNER = 'not yet named: Hein names one before W3 is dispatched (wave-4 spec §8 decision 2; suggested Willie)';
const CRON = '~/bin/isaflow-tax-tables-cron.sh';

const PINNED: Record<number, string> = {
  2025: '98d8b3b416ab3760979667efe61514efd86028a4e582e53dd7a4e6783a3c482d',
  2026: '5df5ce4b15fc6cce1a3d062319367ceeaed38647f913232ea27d3fb1b0671bd4',
  2027: '22a3f91af2e2bd72621052ff487e17204a014b7e3b62fd3b245d9cde751f96af',
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
  const payload = { tax: getTaxYearConfig(taxYear), eti: etiForTaxYear(taxYear), etiPolicy: ETI_AFTER_MARCH_2026_POLICY };
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function supportedYears(): number[] {
  const years: number[] = [];
  for (let y = 2000; y <= 2100; y++) {
    try {
      getTaxYearConfig(y);
      years.push(y);
    } catch (err) {
      if (!(err instanceof UnsupportedTaxYearError)) throw err;
    }
  }
  return years;
}

function checklist(year: number, what: string): string {
  return `Payroll tax tables for tax year ${year}: ${what}. This is the February SARS budget checklist: check `
    + 'every bracket, rebate, threshold, medical credit, the UIF ceiling, the SDL threshold, the s11F cap and the ETI '
    + `table against SARS, then set PINNED[${year}] in tests/unit/services/payroll/taxTableHash.test.ts and re-run `
    + `payrollOracle.test.ts. Table owner: ${TABLE_OWNER}. The ${CRON} cron's headless session opens a taxTables PR `
    + 'every February; that PR must update this pin.';
}

describe('tax-table hash pin', () => {
  it('pins exactly the tax years that have tables', () => {
    const years = supportedYears();
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
