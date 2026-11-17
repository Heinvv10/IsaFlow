/**
 * Nil net pay left out of the salary file (review #1524 round 2, the format reviewer's repro, folded in): a nil-net
 * employee in the MIDDLE of the run keeps the sequence numbers 000001..N without a gap (p.3 field 5), the hash total
 * (p.14) covers only the accounts in the file, and a writer refusal after the skip names the right employee.
 * Wiring with a mocked read; the figures on real PG are in tests/integration/payroll-bank-file-controls.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Record<string, unknown>[] = [];
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => rows), withSavepoint: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/bankRoleHolder', () => ({ resolveBankRoleHolder: vi.fn() }));

import { readPayments } from '@/modules/accounting/services/payroll/payrollBankFileJudge';
import { acbHashTotal, buildAcbPaymentFile, AcbFileInputError } from '@/modules/accounting/services/payroll/payrollAcbFile';

const row = (n: string, acct: string, net: string, holder: string | null = null) => ({
  employee_id: `e-${n}`, employee_number: n, first_name: 'F' + n, last_name: 'L', net_cents: net,
  account_number: acct, branch_code: '632005', account_type: 'savings', account_holder: holder,
  details_after_approval: false, company_name: 'Test Co', period_year: 2026, period_month: 10,
});
const from = { branchCode: '250655', accountNumber: '62000000001' };

describe('nil-net exclusion vs sequence and hash', () => {
  beforeEach(() => {
    rows.length = 0;
    rows.push(row('001', '1111111111', '100000'), row('002', '2222222222', '0'), row('003', '3333333333', '250000'));
  });

  it('keeps the sequence contiguous and hashes only the accounts in the file', async () => {
    const pay = await readPayments('c', 'r');
    expect(pay.who).toEqual(['001', '003']);
    expect(pay.linesCents).toBe(350000n);
    expect(pay.warnings).toEqual(['002 F002 L: not in the file: net pay is nil']);
    const file = buildAcbPaymentFile({ from, actionDate: '2026-11-25', payments: pay.payments });
    const lines = file.content.split('\r\n');
    const txns = lines.filter((l) => l.startsWith('10'));
    expect(txns.map((l) => l.slice(23, 29))).toEqual(['000001', '000002']);
    expect(txns.map((l) => l.slice(35, 46))).toEqual(['01111111111', '03333333333']);
    const expected = (62000000001n + 1111111111n + 3333333333n).toString().padStart(12, '0');
    expect(file.hashTotal).toBe(expected);
    expect(lines.find((l) => l.startsWith('92'))!.slice(72, 84)).toBe(expected);
    expect(acbHashTotal(from, pay.payments)).toBe(expected);
    expect(file.totalCents).toBe(350000);
    expect(file.lineCount).toBe(2);
  });

  it('a writer refusal after the skip names the right employee (who[] stays aligned)', async () => {
    rows[2] = row('003', '3333333333', '250000', '王小明');
    const pay = await readPayments('c', 'r');
    let err: unknown;
    try { buildAcbPaymentFile({ from, actionDate: '2026-11-25', payments: pay.payments }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AcbFileInputError);
    const owner = (err as AcbFileInputError).owner;
    expect(owner.kind === 'payment' && pay.who[owner.index]).toBe('003');
  });

  it('a whitespace-only account_holder falls back to the employee name', async () => {
    rows[0] = row('001', '1111111111', '100000', '   ');
    const pay = await readPayments('c', 'r');
    expect(pay.payments[0]!.accountName).toBe('F001 L');
  });
});
