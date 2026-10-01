/**
 * K-029 follow-up: the consumers that read the shared schedule.
 *
 * MEDIUM-5 — the depreciation CSV export hard-coded straight line, and the
 * route it self-fetched over HTTP does not exist, so it emitted a header-only
 * file for every company.
 * LOW-B — assetService divided the annual charge by twelve but had no
 * final-month true-up, so it returned less than the run posts.
 * LOW-C — the asset detail schedule trued up on the last DISPLAYED row rather
 * than the last year of the life, inventing a write-off for a long-lived asset.
 */
import { describe, it, expect } from 'vitest';
import {
  buildDepreciationCsv,
  DEPRECIATION_CSV_HEADER,
} from '../../../pages/api/accounting/depreciation-export';
import { calculateDepreciation } from '@/modules/accounting/services/items/assetService';
import {
  buildDepreciationSchedule,
  type ScheduleAsset,
} from '@/modules/accounting/services/items/depreciationSchedule';

describe('depreciation CSV export (MEDIUM-5)', () => {
  const row = {
    asset_number: 'K029-CSV-1', name: 'Reducing balance plant',
    purchase_date: '2024-01-15', purchase_price: 100_000, salvage_value: 0,
    useful_life_years: 5, depreciation_method: 'reducing_balance',
    accumulated_depreciation: 73_600, current_book_value: 26_400,
    disposal_date: null,
  };

  it('quotes the method charge, not the straight-line one', () => {
    // Month 32 = depreciation year 3: 36 000 x 2/5 = 14 400 -> 1 200.00.
    // Straight line would say 1 666.67.
    const csv = buildDepreciationCsv([row], '2026-09-30');
    const [header, line] = csv.split('\n');
    expect(header).toBe(DEPRECIATION_CSV_HEADER);
    // csvCell quotes every text column.
    expect(line).toBe('"K029-CSV-1","Reducing balance plant",100000.00,26400.00,73600.00,5,0.00,"reducing_balance",1200.00');
  });

  it('names the method in its own column for each of the three', () => {
    const csv = buildDepreciationCsv([
      { ...row, asset_number: 'A', depreciation_method: 'straight_line', accumulated_depreciation: 0 },
      { ...row, asset_number: 'B', depreciation_method: 'sum_of_years', accumulated_depreciation: 0 },
      { ...row, asset_number: 'C', depreciation_method: 'reducing_balance', accumulated_depreciation: 0 },
    ], '2026-09-30');
    const charges = csv.split('\n').slice(1).map((l) => l.split(',').slice(-2));
    // straight line 100 000/5/12; sum-of-years year 3 = 100 000 x 3/15 / 12;
    // reducing balance year 3 opens at 36 000 -> 14 400 / 12.
    expect(charges).toEqual([
      ['"straight_line"', '1666.67'],
      ['"sum_of_years"', '1666.67'],
      ['"reducing_balance"', '1200.00'],
    ]);
  });

  it('charges nothing for an asset disposed before the period', () => {
    const csv = buildDepreciationCsv([{ ...row, disposal_date: '2026-05-31' }], '2026-09-30');
    expect(csv.split('\n')[1]!.endsWith(',0.00')).toBe(true);
  });

  it('emits the header alone for an empty register', () => {
    expect(buildDepreciationCsv([], '2026-09-30')).toBe(DEPRECIATION_CSV_HEADER);
  });

  it('caps the export and says so rather than ending quietly (LOW-E)', () => {
    // The query asks for MAX_EXPORT_ROWS + 1 so the builder can tell a full
    // page from an overflow. 5 001 rows in, 5 000 assets plus a marker out.
    const many = Array.from({ length: 5_001 }, (_, i) => ({ ...row, asset_number: `A${i}` }));
    const lines = buildDepreciationCsv(many, '2026-09-30').split('\n');
    expect(lines).toHaveLength(5_002);           // header + 5 000 + marker
    expect(lines[5_001]).toContain('TRUNCATED');
    expect(lines[5_000]).toContain('A4999');
  });

  it('emits no marker when the register fits', () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({ ...row, asset_number: `A${i}` }));
    const lines = buildDepreciationCsv(many, '2026-09-30').split('\n');
    expect(lines).toHaveLength(5_001);
    expect(lines[5_000]).not.toContain('TRUNCATED');
  });

  it('reads a missing accumulated_depreciation as zero, not NaN (LOW-F)', () => {
    const { accumulated_depreciation: _omitted, ...noAccDep } = row;
    const line = buildDepreciationCsv([noAccDep], '2026-09-30').split('\n')[1]!;
    expect(line).not.toContain('NaN');
    // Year 3 with nothing accumulated still charges 1 200.00, and the accum
    // column reads 0.00 rather than NaN.
    expect(line.split(',').slice(-5)).toEqual(['0.00', '5', '0.00', '"reducing_balance"', '1200.00']);
  });
});

describe('assetService final-month true-up (LOW-B)', () => {
  it('charges the whole remaining balance in the final month of the life', () => {
    // 5-year life = 60 months, so month index 59 is the last. 100 000 taken
    // down to 98 000 leaves 2 000, against a normal month of 1 666.67.
    const final = calculateDepreciation({
      cost: 100_000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 59,
      method: 'straight_line', accumulatedDepreciation: 98_000,
    });
    expect(final.monthlyAmount).toBeCloseTo(2_000, 2);
  });

  it('charges a normal month one period earlier', () => {
    const penultimate = calculateDepreciation({
      cost: 100_000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 58,
      method: 'straight_line', accumulatedDepreciation: 96_333.33,
    });
    expect(penultimate.monthlyAmount).toBeCloseTo(1_666.67, 2);
  });

  it('agrees with the run for the same asset and month', () => {
    for (const method of ['straight_line', 'reducing_balance', 'sum_of_years'] as const) {
      const viaService = calculateDepreciation({
        cost: 100_000, salvageValue: 0, usefulLifeYears: 5, monthsElapsed: 24, method,
      });
      // Year 3: straight line 20 000, reducing balance 14 400, SYD 100 000 x 3/15.
      const expected = { straight_line: 20_000, reducing_balance: 14_400, sum_of_years: 20_000 }[method];
      expect(viaService.annualAmount).toBeCloseTo(expected, 2);
    }
  });
});

describe('asset detail schedule (LOW-C)', () => {
  const asset: ScheduleAsset = {
    useful_life_years: 5, purchase_price: 100_000, salvage_value: 0,
    depreciation_method: 'reducing_balance',
  };

  it('shows the declining schedule the run posts, ending on the residual', () => {
    const rows = buildDepreciationSchedule(asset);
    expect(rows.map((r) => Math.round(r.dep))).toEqual([40_000, 24_000, 14_400, 10_800, 10_800]);
    expect(rows[4]!.close).toBeCloseTo(0, 2);
  });

  it('stops on the residual rather than at zero', () => {
    const rows = buildDepreciationSchedule({ ...asset, salvage_value: 10_000 });
    expect(rows[4]!.close).toBeCloseTo(10_000, 2);
    expect(rows.reduce((t, r) => t + r.dep, 0)).toBeCloseTo(90_000, 2);
  });

  it('does not invent a write-off on the last displayed row of a long life', () => {
    // 40-year life, table capped at 30 rows. Year 30 must be an ordinary year,
    // not the whole remaining book value.
    const rows = buildDepreciationSchedule({ ...asset, useful_life_years: 40, depreciation_method: 'straight_line' });
    expect(rows).toHaveLength(30);
    expect(rows[29]!.dep).toBeCloseTo(2_500, 2);   // 100 000 / 40
    expect(rows[29]!.close).toBeCloseTo(25_000, 2);
  });
});
