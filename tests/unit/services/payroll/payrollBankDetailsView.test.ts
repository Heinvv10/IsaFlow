// Wave 3 K1: GET bank details masks the account number, branch code and holder for anyone but owner / admin, so a
// manager walking employees cannot match two of them to one account by the unmasked fields. Bank name stays.
import { beforeEach, describe, expect, it, vi } from 'vitest';

let rows: unknown[] = [];
vi.mock('@/lib/neon', () => ({ sql: () => Promise.resolve(rows) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getEmployeeBankDetails } from '@/modules/accounting/services/payroll/payrollBankDetailsService';

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EMPLOYEE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROW = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', employee_id: EMPLOYEE_ID, bank_name: 'FNB', account_number: '62000123456',
  account_type: 'cheque', branch_code: '250655', account_holder: 'Élise One', effective_from: '2026-11-03',
};

beforeEach(() => { rows = [ROW]; });

describe('getEmployeeBankDetails masking', () => {
  it.each(['manager', 'viewer', undefined])('masks number, branch code and holder for %s; keeps the bank name', async (role) => {
    const view = await getEmployeeBankDetails(COMPANY_ID, EMPLOYEE_ID, role);
    expect(view).toMatchObject({
      bankName: 'FNB', accountNumber: '…3456', branchCode: '…55', accountHolder: 'É…', masked: true,
    });
    const body = JSON.stringify(view);
    expect(body).not.toContain('250655');
    expect(body).not.toContain('Élise');
  });

  it('leaves a missing holder null when masked', async () => {
    rows = [{ ...ROW, account_holder: null }];
    expect((await getEmployeeBankDetails(COMPANY_ID, EMPLOYEE_ID, 'manager'))?.accountHolder).toBeNull();
  });

  it.each(['owner', 'admin'])('gives a %s everything in full', async (role) => {
    expect(await getEmployeeBankDetails(COMPANY_ID, EMPLOYEE_ID, role)).toMatchObject({
      bankName: 'FNB', accountNumber: '62000123456', branchCode: '250655', accountHolder: 'Élise One', masked: false,
    });
  });
});
