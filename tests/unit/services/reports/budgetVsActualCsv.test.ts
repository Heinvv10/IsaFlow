import { describe, it, expect } from 'vitest';
import { buildBudgetVsActualLines, type RawActualRow } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { buildBudgetVsActualSections } from '@/modules/accounting/services/reports/budgetVsActualSections';
import { budgetVsActualCsv, BUDGET_VS_ACTUAL_CSV_HEADER } from '@/modules/accounting/services/reports/budgetVsActualCsv';

const row = (code: string, type: 'revenue' | 'expense', actual: number, name = `Acc ${code}`): RawActualRow => ({
  id: `id-${code}`, account_code: code, account_name: name, account_type: type, actual_amount: actual,
});

function model(raws: RawActualRow[], budgets: Record<string, number>) {
  const lines = buildBudgetVsActualLines(raws, budgets);
  return { lines, sections: buildBudgetVsActualSections(lines) };
}

/** Minimal RFC-4180 parse: every cell csvVal writes is quoted; numbers are bare. */
function parse(csv: string): string[][] {
  return csv.split('\n').map((line) => {
    const cells: string[] = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let v = ''; i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { v += '"'; i += 2; } else if (line[i] === '"') { i++; break; } else { v += line[i++]; }
        }
        cells.push(v); i++;
      } else {
        const j = line.indexOf(',', i);
        const end = j === -1 ? line.length : j;
        cells.push(line.slice(i, end)); i = end + 1;
      }
    }
    return cells;
  });
}

const FIXTURE = model(
  [row('4000', 'revenue', 1200, 'Sales, local'), row('4100', 'revenue', 300), row('6000', 'expense', 800), row('6100', 'expense', 50)],
  { 'id-4000': 1000, 'id-6000': 500, 'id-6100': 0 },
);

describe('budgetVsActualCsv', () => {
  it('Variance is actual − budget for revenue and expense; Favourable carries the polarity', () => {
    const t = parse(budgetVsActualCsv(FIXTURE));
    expect(t[0]).toEqual(BUDGET_VS_ACTUAL_CSV_HEADER.split(','));
    const rev = t.find((r) => r[1] === '4000')!;
    const exp = t.find((r) => r[1] === '6000')!;
    expect(rev).toEqual(['Revenue', '4000', 'Sales, local', '1000.00', '1200.00', '200.00', '20.00', 'yes']);
    expect(exp).toEqual(['Expenses', '6000', 'Acc 6000', '500.00', '800.00', '300.00', '60.00', 'no']);
  });

  it('rows, section totals and net profit in order; null pct is an empty cell', () => {
    const t = parse(budgetVsActualCsv(FIXTURE));
    expect(t.map((r) => [r[0], r[1], r[2]])).toEqual([
      ['Section', 'Account Code', 'Account Name'],
      ['Revenue', '4000', 'Sales, local'],
      ['Revenue', '4100', 'Acc 4100'],
      ['Revenue', '', 'Total revenue'],
      ['Expenses', '6000', 'Acc 6000'],
      ['Expenses', '6100', 'Acc 6100'],
      ['Expenses', '', 'Total expenses'],
      ['Net profit', '', 'Net profit'],
    ]);
    // Unbudgeted revenue: Budget, % and Favourable are empty; the movement is still printed.
    expect(t[2]!.slice(3)).toEqual(['', '300.00', '300.00', '', '']);
    // A deliberate zero budget prints 0.00, its % is empty, and it is unfavourable.
    expect(t[5]!.slice(3)).toEqual(['0.00', '50.00', '50.00', '', 'no']);
    // NP: budget 1000 − 500 = 500, actual 1500 − 850 = 650.
    expect(t[7]!.slice(3)).toEqual(['500.00', '650.00', '150.00', '30.00', 'yes']);
  });

  it('every figure equals the JSON figure it came from (round-trip parse)', () => {
    const t = parse(budgetVsActualCsv(FIXTURE));
    for (const l of FIXTURE.lines) {
      const r = t.find((x) => x[1] === l.account_code)!;
      expect(r[3] === '' ? null : Number(r[3])).toBe(l.budgeted ? l.budget_amount : null);
      expect(Number(r[4])).toBe(l.actual_amount);
      expect(Number(r[5])).toBe(l.movement);
      expect(r[6] === '' ? null : Number(r[6])).toBe(l.movement_pct === null ? null : Number(l.movement_pct.toFixed(2)));
    }
    const np = t[t.length - 1]!;
    expect([Number(np[3]), Number(np[4]), Number(np[5])]).toEqual([
      FIXTURE.sections.net_profit.budget, FIXTURE.sections.net_profit.actual, FIXTURE.sections.net_profit.movement,
    ]);
  });

  it('a negative movement prints as a bare number, not a formula-guarded string', () => {
    const t = parse(budgetVsActualCsv(model([row('4000', 'revenue', 700)], { 'id-4000': 1000 })));
    expect(t[1]!.slice(3, 8)).toEqual(['1000.00', '700.00', '-300.00', '-30.00', 'no']);
  });

  it('not-started year: the header plus three zero total rows', () => {
    const t = parse(budgetVsActualCsv(model([], {})));
    expect(t).toEqual([
      BUDGET_VS_ACTUAL_CSV_HEADER.split(','),
      ['Revenue', '', 'Total revenue', '0.00', '0.00', '0.00', '', ''],
      ['Expenses', '', 'Total expenses', '0.00', '0.00', '0.00', '', ''],
      ['Net profit', '', 'Net profit', '0.00', '0.00', '0.00', '', ''],
    ]);
  });

  it('an account name that starts with a formula character is guarded', () => {
    const t = parse(budgetVsActualCsv(model([row('6000', 'expense', 10, '=HYPERLINK("x")')], {})));
    expect(t.find((r) => r[1] === '6000')![2]).toBe('\'=HYPERLINK("x")');
  });
});
