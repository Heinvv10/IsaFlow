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

import {
  createExternalImport,
  deleteExternalImport,
  getExternalImport,
  getExternalImportPayslips,
  listExternalImports,
} from '@/modules/accounting/services/payroll/payrollExternalImportService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const IMPORT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const HEADER_ROW = {
  id: IMPORT_ID,
  company_id: COMPANY_ID,
  period_month: 8,
  period_year: 2026,
  source: 'VIP Premier',
  file_name: 'aug.csv',
  payslip_count: 2,
  components_present: ['gross', 'net'],
  created_at: new Date('2026-08-31T10:00:00Z'),
};

function routeMock(routes: Array<{ match: string; rows: unknown[] }>) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    const hit = routes.find((r) => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('createExternalImport', () => {
  const input = {
    periodMonth: 8,
    periodYear: 2026,
    source: 'VIP Premier',
    fileName: 'aug.csv',
    componentsPresent: ['gross', 'net'] as Array<'gross' | 'net'>,
    rows: [
      { employeeNumber: 'E001', employeeName: 'Thandi', amounts: { gross: 2500000, net: 2089034 } },
      { employeeNumber: 'E002', employeeName: null, amounts: { net: 1500000 } },
    ],
    createdBy: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  };

  it('inserts the header company-scoped and bulk-inserts payslips via unnest', async () => {
    routeMock([{ match: 'INSERT INTO payroll_external_imports', rows: [HEADER_ROW] }]);
    const result = await createExternalImport(COMPANY_ID, input);

    expect(result.id).toBe(IMPORT_ID);
    expect(result.createdAt).toBe('2026-08-31T10:00:00.000Z');

    const headerCall = sqlCalls.find((c) => c.sql.includes('INSERT INTO payroll_external_imports'))!;
    expect(headerCall.values).toContain(COMPANY_ID);

    const payslipCall = sqlCalls.find((c) => c.sql.includes('INSERT INTO payroll_external_payslips'))!;
    expect(payslipCall.sql).toContain('unnest');
    expect(payslipCall.values).toContainEqual([ 'E001', 'E002' ]);
    expect(payslipCall.values).toContainEqual([ 2500000, null ]);   // gross: absent on E002 → null
    expect(payslipCall.values).toContainEqual([ 2089034, 1500000 ]); // net
    expect(payslipCall.values).toContain(COMPANY_ID);
  });

  it('skips the payslip insert when there are no rows', async () => {
    routeMock([{ match: 'INSERT INTO payroll_external_imports', rows: [{ ...HEADER_ROW, payslip_count: 0 }] }]);
    await createExternalImport(COMPANY_ID, { ...input, rows: [] });
    expect(sqlCalls.some((c) => c.sql.includes('payroll_external_payslips'))).toBe(false);
  });

  it('throws when the header insert returns nothing', async () => {
    await expect(createExternalImport(COMPANY_ID, input)).rejects.toThrow(/Failed to create/);
  });
});

describe('reads and delete', () => {
  it('listExternalImports filters by company_id', async () => {
    routeMock([{ match: 'FROM payroll_external_imports', rows: [HEADER_ROW] }]);
    const list = await listExternalImports(COMPANY_ID);
    expect(list).toHaveLength(1);
    expect(list[0]!.periodMonth).toBe(8);
    expect(sqlCalls[0]!.sql).toContain('company_id =');
    expect(sqlCalls[0]!.values).toContain(COMPANY_ID);
  });

  it('getExternalImport returns null when not found (wrong company)', async () => {
    expect(await getExternalImport(COMPANY_ID, IMPORT_ID)).toBeNull();
    expect(sqlCalls[0]!.values).toContain(COMPANY_ID);
  });

  it('getExternalImportPayslips maps cents and omits NULL components', async () => {
    routeMock([{
      match: 'FROM payroll_external_payslips',
      rows: [{
        employee_number: 'E001', employee_name: 'Thandi',
        gross_cents: '2500000', paye_cents: null, uif_employee_cents: null,
        uif_employer_cents: null, uif_total_cents: '35424', sdl_cents: null,
        eti_cents: null, net_cents: '2089034',
      }],
    }]);
    const rows = await getExternalImportPayslips(COMPANY_ID, IMPORT_ID);
    expect(rows[0]!.amounts).toEqual({ gross: 2500000, uifTotal: 35424, net: 2089034 });
    expect(sqlCalls[0]!.values).toContain(COMPANY_ID);
  });

  it('deleteExternalImport is company-scoped and reports not-found', async () => {
    expect(await deleteExternalImport(COMPANY_ID, IMPORT_ID)).toBe(false);
    expect(sqlCalls[0]!.sql).toContain('DELETE FROM payroll_external_imports');
    expect(sqlCalls[0]!.values).toContain(COMPANY_ID);

    routeMock([{ match: 'DELETE FROM payroll_external_imports', rows: [{ id: IMPORT_ID }] }]);
    expect(await deleteExternalImport(COMPANY_ID, IMPORT_ID)).toBe(true);
  });
});
