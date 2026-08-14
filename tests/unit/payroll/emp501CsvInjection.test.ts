import { describe, it, expect } from 'vitest';
import { buildEmp501Csv } from '@/../pages/api/payroll/emp501/export';

describe('EMP501 CSV export — formula-injection safety', () => {
  it('neutralizes a leading formula character in the employee name', () => {
    const rows = [
      {
        first_name: '=cmd|',
        last_name: "'/c calc'!A0",
        tax_number: '@SUM(1,1)',
        gross_income: 1000,
        total_paye: 100,
        total_uif: 10,
        total_sdl: 5,
      },
    ];
    const csv = buildEmp501Csv(rows as never[]);
    const dataLine = csv.split('\n')[1]!;
    // The `=cmd|...` name and `@SUM...` tax number must be prefixed with a single quote.
    expect(dataLine).toContain("'=cmd");
    expect(dataLine).toContain("'@SUM(1,1)");
    expect(dataLine).not.toMatch(/(^|,)=cmd/);
  });
});
