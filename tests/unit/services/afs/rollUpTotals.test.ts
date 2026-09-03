/**
 * rollUpTotals — how a statement subtotal gets its number.
 *
 * Six lines on every production company's taxonomy rendered 0.00, and they
 * were the six a reader looks at first: Total assets, Total equity and
 * liabilities, and all four income statement bottom lines. Each is top-level,
 * with no parent_code, and the roll-up summed only "siblings sharing my
 * parent_code" — so it found nothing and left them at the GL's 0, because no
 * GL account maps to a subtotal.
 *
 * The fixtures below mirror the real seeded taxonomy: codes, sort orders and
 * hierarchy are the ones in afs_statement_lines in production.
 *
 * Amounts are RAW `debit - credit`, which is the space rollUpTotals works in.
 * The display sign flip happens afterwards in the statement generators.
 */
import { describe, it, expect } from 'vitest';
import { rollUpTotals, type SectionLine } from '@/modules/accounting/services/afs/noteGenerators/primaryStatements/_helpers';

function line(partial: Partial<SectionLine> & { code: string; sortOrder: number }): SectionLine {
  return {
    label: partial.code,
    parentCode: null,
    noteNumber: null,
    isHeader: false,
    isTotal: false,
    currentAmount: 0,
    priorAmount: 0,
    totalBasis: 'children',
    totalComponents: null,
    ...partial,
  };
}

// Mirrors the seeded balance sheet: two asset groups each with their own
// parented subtotal, then a top-level Total assets over those subtotals.
function balanceSheetFixture(): SectionLine[] {
  return [
    line({ code: 'BS001', sortOrder: 10, isHeader: true }),
    line({ code: 'BS002', sortOrder: 20, parentCode: 'BS001', currentAmount: 700, priorAmount: 600 }),
    line({ code: 'BS019', sortOrder: 190, parentCode: 'BS001', currentAmount: 300, priorAmount: 250 }),
    line({ code: 'BS021', sortOrder: 210, parentCode: 'BS001', isTotal: true }),

    line({ code: 'BS023', sortOrder: 230, isHeader: true }),
    line({ code: 'BS028', sortOrder: 280, parentCode: 'BS023', currentAmount: 150, priorAmount: 100 }),
    line({ code: 'BS036', sortOrder: 360, parentCode: 'BS023', currentAmount: 50, priorAmount: 40 }),
    line({ code: 'BS037', sortOrder: 370, parentCode: 'BS023', isTotal: true }),

    line({
      code: 'BS038', sortOrder: 380, isTotal: true,
      totalBasis: 'components', totalComponents: ['BS021', 'BS037'],
    }),

    line({ code: 'BS040', sortOrder: 400, isHeader: true }),
    line({ code: 'BS041', sortOrder: 410, parentCode: 'BS040', isHeader: true }),
    line({ code: 'BS042', sortOrder: 420, parentCode: 'BS041', currentAmount: -400, priorAmount: -400 }),
    line({ code: 'BS048', sortOrder: 480, parentCode: 'BS041', isTotal: true }),
    line({ code: 'BS049', sortOrder: 490, parentCode: 'BS040', isHeader: true }),
    line({ code: 'BS050', sortOrder: 500, parentCode: 'BS049', currentAmount: -500, priorAmount: -300 }),
    line({ code: 'BS057', sortOrder: 570, parentCode: 'BS049', isTotal: true }),
    line({ code: 'BS060', sortOrder: 600, parentCode: 'BS040', isHeader: true }),
    line({ code: 'BS061', sortOrder: 610, parentCode: 'BS060', currentAmount: -300, priorAmount: -290 }),
    line({ code: 'BS073', sortOrder: 730, parentCode: 'BS060', isTotal: true }),

    line({
      code: 'BS082', sortOrder: 820, isTotal: true,
      totalBasis: 'components', totalComponents: ['BS048', 'BS057', 'BS073'],
    }),
  ];
}

// Mirrors the seeded income statement: leaves under headers, then four
// top-level RUNNING totals, with un-parented interest and tax lines between.
function incomeStatementFixture(): SectionLine[] {
  return [
    line({ code: 'IS001', sortOrder: 1010, isHeader: true }),
    line({ code: 'IS002', sortOrder: 1020, parentCode: 'IS001', currentAmount: -1000, priorAmount: -900 }),
    line({ code: 'IS156', sortOrder: 2560, isHeader: true }),
    line({ code: 'IS401', sortOrder: 5010, parentCode: 'IS156', currentAmount: 400, priorAmount: 350 }),

    line({ code: 'IS452', sortOrder: 5520, isTotal: true, totalBasis: 'running' }),

    line({ code: 'IS454', sortOrder: 5540, currentAmount: 100, priorAmount: 90 }),

    line({ code: 'IS471', sortOrder: 5710, isTotal: true, totalBasis: 'running' }),

    line({ code: 'IS476', sortOrder: 5760, currentAmount: 140, priorAmount: 120 }),

    line({ code: 'IS480', sortOrder: 5800, isTotal: true, totalBasis: 'running' }),

    line({ code: 'IS484', sortOrder: 5840, currentAmount: 60, priorAmount: 0 }),

    line({ code: 'IS485', sortOrder: 5850, isTotal: true, totalBasis: 'running' }),
  ];
}

const byCode = (lines: SectionLine[]) => new Map(lines.map((l) => [l.code, l]));

describe('rollUpTotals — parented subtotals', () => {
  it('still sums the non-total children that share a parent', () => {
    const out = byCode(rollUpTotals(balanceSheetFixture()));

    expect(out.get('BS021')?.currentAmount).toBe(1000); // 700 + 300
    expect(out.get('BS037')?.currentAmount).toBe(200);  // 150 + 50
    expect(out.get('BS021')?.priorAmount).toBe(850);
  });

  it('does not overwrite a total that already carries a figure', () => {
    const lines = balanceSheetFixture();
    const bs021 = lines.find((l) => l.code === 'BS021')!;
    bs021.currentAmount = 999;

    const out = byCode(rollUpTotals(lines));
    expect(out.get('BS021')?.currentAmount).toBe(999);
    // The prior year was 0 and still rolls up — the two years are independent.
    expect(out.get('BS021')?.priorAmount).toBe(850);
  });
});

describe('rollUpTotals — top-level totals with no parent', () => {
  it('computes Total assets from its component subtotals', () => {
    const out = byCode(rollUpTotals(balanceSheetFixture()));
    // Previously 0.00: BS038 has no parent_code, so no siblings were found.
    expect(out.get('BS038')?.currentAmount).toBe(1200); // 1000 + 200
    expect(out.get('BS038')?.priorAmount).toBe(990);    // 850 + 140
  });

  it('computes Total equity and liabilities from its three subtotals', () => {
    const out = byCode(rollUpTotals(balanceSheetFixture()));
    expect(out.get('BS082')?.currentAmount).toBe(-1200); // -400 + -500 + -300
    expect(out.get('BS082')?.priorAmount).toBe(-990);
  });

  it('balances: total assets equals total equity and liabilities', () => {
    const out = byCode(rollUpTotals(balanceSheetFixture()));
    // In raw debit-minus-credit space the two are equal and opposite. This is
    // the property the whole statement exists to demonstrate.
    expect(out.get('BS038')!.currentAmount).toBe(-out.get('BS082')!.currentAmount);
    expect(out.get('BS038')!.priorAmount).toBe(-out.get('BS082')!.priorAmount);
  });

  it('a components total does not include the leaves twice', () => {
    const out = byCode(rollUpTotals(balanceSheetFixture()));
    // BS038 sums the two SUBTOTALS, not the subtotals plus their leaves.
    expect(out.get('BS038')?.currentAmount).not.toBe(2400);
  });

  it('a components total reads the subtotal itself, not the leaves beneath it', () => {
    // The two are equal in the ordinary case, so this is the only fixture that
    // can tell them apart: BS021 carries its own figure, which must be what
    // Total assets adds — reaching past it to re-sum its children would report
    // 1200 and quietly contradict the subtotal printed directly above.
    const lines = balanceSheetFixture();
    lines.find((l) => l.code === 'BS021')!.currentAmount = 999;

    const out = byCode(rollUpTotals(lines));
    expect(out.get('BS038')?.currentAmount).toBe(1199); // 999 + 200
  });
});

describe('rollUpTotals — running totals on the income statement', () => {
  it('accumulates each total from the previous one plus the lines between', () => {
    const out = byCode(rollUpTotals(incomeStatementFixture()));

    // Raw space: revenue is negative, costs positive. -1000 + 400 = -600.
    expect(out.get('IS452')?.currentAmount).toBe(-600);
    // plus interest paid 100
    expect(out.get('IS471')?.currentAmount).toBe(-500);
    // plus taxation 140
    expect(out.get('IS480')?.currentAmount).toBe(-360);
    // plus dividends paid 60.
    //
    // -300 is this fixture's retained profit for the year, NOT an accumulated
    // balance: the fixture has no opening-accumulated line. In the real
    // statement fetchSectionLines derives one and inserts it just before
    // IS485, so the running chain carries every prior year too — proved in
    // tests/integration/afs-accumulated-income.int.test.ts. rollUpTotals is
    // the summation rule and is agnostic about which lines it is given.
    expect(out.get('IS485')?.currentAmount).toBe(-300);
  });

  it('accumulates the prior year independently of the current year', () => {
    const out = byCode(rollUpTotals(incomeStatementFixture()));

    expect(out.get('IS452')?.priorAmount).toBe(-550); // -900 + 350
    expect(out.get('IS471')?.priorAmount).toBe(-460);
    expect(out.get('IS480')?.priorAmount).toBe(-340);
    expect(out.get('IS485')?.priorAmount).toBe(-340); // dividends 0 in prior year
  });

  it('does not count a line into two consecutive running totals', () => {
    const out = byCode(rollUpTotals(incomeStatementFixture()));
    // If the bucket were not reset at each total, IS471 would re-add the
    // revenue and cost lines and read -1100 rather than -500.
    expect(out.get('IS471')?.currentAmount).not.toBe(-1100);
  });

  it('leaves every non-total line untouched', () => {
    const before = incomeStatementFixture();
    const out = byCode(rollUpTotals(before));

    for (const l of before.filter((x) => !x.isTotal)) {
      expect(out.get(l.code)?.currentAmount).toBe(l.currentAmount);
      expect(out.get(l.code)?.priorAmount).toBe(l.priorAmount);
    }
  });
});
