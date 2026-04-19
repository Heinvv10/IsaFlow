import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { generatePayslipPdf } from '@/modules/accounting/services/payroll/payslipPdfService';

beforeEach(() => {
  sqlCalls.length = 0;
});

describe('generatePayslipPdf', () => {
  it('returns a Buffer starting with %PDF magic bytes', async () => {
    mockImpl = (strings) => {
      const s = strings.join('?');
      if (s.includes('FROM payroll_run_headers')) {
        return Promise.resolve([{
          period_month: 3,
          period_year: 2025,
          status: 'calculated',
          company_name: 'Test Co',
        }]);
      }
      if (s.includes('FROM payroll_run_lines')) {
        return Promise.resolve([{
          gross_pay: 25000,
          paye: 3483,
          uif_employee: 177,
          uif_employer: 177,
          sdl: 0,
          net_pay: 21340,
          component_breakdown: [
            {
              componentId: 'c1',
              componentName: 'Basic',
              sarsSourceCode: '3601',
              amount: 25000,
              isTaxable: true,
              isUifApplicable: true,
            },
          ],
        }]);
      }
      if (s.includes('FROM payroll_employees')) {
        return Promise.resolve([{
          first_name: 'John',
          last_name: 'Doe',
          employee_number: 'E1',
          id_number: null,
          tax_number: null,
        }]);
      }
      return Promise.resolve([]);
    };

    const buf = await generatePayslipPdf('c-1', 'r-1', 'e-1');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('throws when the run cannot be loaded', async () => {
    mockImpl = (strings) => {
      const s = strings.join('?');
      if (s.includes('FROM payroll_run_headers')) return Promise.resolve([]);
      return Promise.resolve([]);
    };
    await expect(generatePayslipPdf('c-1', 'r-1', 'e-1')).rejects.toThrow(/not found/);
  });

  it('produces a non-trivial payload (>500 bytes)', async () => {
    mockImpl = (strings) => {
      const s = strings.join('?');
      if (s.includes('FROM payroll_run_headers')) {
        return Promise.resolve([{
          period_month: 3,
          period_year: 2025,
          status: 'calculated',
          company_name: 'Test Co',
        }]);
      }
      if (s.includes('FROM payroll_run_lines')) {
        return Promise.resolve([{
          gross_pay: 25000,
          paye: 3483,
          uif_employee: 177,
          uif_employer: 177,
          sdl: 0,
          net_pay: 21340,
          component_breakdown: [],
        }]);
      }
      if (s.includes('FROM payroll_employees')) {
        return Promise.resolve([{
          first_name: 'John',
          last_name: 'Doe',
          employee_number: 'E1',
          id_number: null,
          tax_number: null,
        }]);
      }
      return Promise.resolve([]);
    };
    const buf = await generatePayslipPdf('c-1', 'r-1', 'e-1');
    expect(buf.length).toBeGreaterThan(500);
  });
});
