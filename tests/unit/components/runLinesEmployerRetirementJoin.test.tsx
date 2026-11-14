/**
 * Wave 5 RF round 2 (tdd L1): the run line read from the database carries `employerRetirement` (payrollRunLines.getPayrollRunLines),
 * and that figure reaches the run-lines table's Gross tooltip. The row comes through the real mapper; only the SQL is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

const rows: unknown[] = [];
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => rows) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getPayrollRunLines } from '@/modules/accounting/services/payroll/payrollRunLines';
import { PayrollRunLinesTable } from '@/components/payroll/PayrollRunLinesTable';

afterEach(cleanup);

describe('employerRetirement from a stored line to the Gross tooltip', () => {
  it('a line with a taxable non-cash 3817 of 2 250 reads 2 250 and the tooltip names it', async () => {
    rows.splice(0, rows.length, {
      id: 'l1', run_id: 'r1', employee_id: 'e1', employee_number: 'RFQA-1', first_name: 'Rufaro', last_name: 'Pension',
      gross_pay: '30000', taxable_income: '32250', paye: '4681', uif_employee: '177.12', uif_employer: '177.12', sdl: '300', eti: '0', net_pay: '25141.88',
      component_breakdown: [
        { componentId: 's', sarsSourceCode: '3601', amount: 30000, isTaxable: true },
        { componentId: 'r', sarsSourceCode: '3817', amount: 2250, isTaxable: true, isNonCash: true },
      ],
      validation_results: [],
    });
    const [line] = await getPayrollRunLines('r1', 'c1');
    expect(line!.employerRetirement).toBe(2250);
    render(<PayrollRunLinesTable lines={[line!]} />);
    const title = screen.getByText(/\+ R 2 250\.00 non-cash/).closest('td')!.getAttribute('title');
    expect(title).toMatch(/of which R\s2\s250\.00 is the employer's retirement fund contribution/);
  });
});
