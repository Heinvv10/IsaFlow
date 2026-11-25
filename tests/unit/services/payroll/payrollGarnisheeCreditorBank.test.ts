/**
 * payrollGarnisheeCreditorBank (wave 7 GC1): the masked view, and the service's rules decided before any write —
 * a manager's change is refused with no UPDATE and no audit row; the same details write nothing; a full read is
 * owner / admin only and audited; a change's audit row holds masked values only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', async (importOriginal) => ({ ...await importOriginal<object>(), sql: vi.fn() }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));

import { sql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { creditorBankView, CreditorBankRefusal, getCreditorBank, setCreditorBank } from '@/modules/accounting/services/payroll/payrollGarnisheeCreditorBank';

const ROW = {
  id: 'o1', creditor_bank_name: 'First National Bank', creditor_branch_code: '250655', creditor_account_number: '62001234567',
  creditor_account_type: 'cheque', creditor_account_holder: 'Acme Credit Ltd', creditor_bank_set_at: new Date('2027-01-02T08:00:00Z'),
};
const EMPTY = { id: 'o1', creditor_bank_name: null, creditor_branch_code: null, creditor_account_number: null, creditor_account_type: null, creditor_account_holder: null, creditor_bank_set_at: null };
const INPUT = { bankName: 'Standard Bank', branchCode: '051001', accountNumber: '10098765432', accountType: 'savings' as const, accountHolder: null };
const ACTOR = { userId: 'u1' };
const sqlText = () => vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));

beforeEach(() => { vi.mocked(sql).mockReset(); vi.mocked(logAuditOrThrow).mockReset(); });

describe('creditorBankView', () => {
  it('masks the number to its last four, the branch to its last two, the holder to its initial; full only when asked', () => {
    expect(creditorBankView(ROW, false)).toMatchObject({ accountNumber: '…4567', branchCode: '…55', accountHolder: 'A…', bankName: 'First National Bank', masked: true });
    expect(creditorBankView(ROW, true)).toMatchObject({ accountNumber: '62001234567', branchCode: '250655', accountHolder: 'Acme Credit Ltd', masked: false });
    expect(creditorBankView(EMPTY, true)).toBeNull();
  });
});

describe('setCreditorBank', () => {
  it('a manager\'s change of entered details is refused before any UPDATE or audit row', async () => {
    vi.mocked(sql).mockResolvedValueOnce([ROW] as never);
    await expect(setCreditorBank('c1', 'e1', 'o1', INPUT, 'manager', ACTOR)).rejects.toMatchObject({ code: 'CHANGE_REQUIRES_ADMIN', status: 403 });
    expect(sqlText().some((t) => /UPDATE payroll_garnishee_orders/.test(t))).toBe(false);
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it('another company\'s order is 404 with no write', async () => {
    vi.mocked(sql).mockResolvedValueOnce([] as never);
    await expect(setCreditorBank('c1', 'e1', 'o1', INPUT, 'owner', ACTOR)).rejects.toBeInstanceOf(CreditorBankRefusal);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it('the same details again write nothing', async () => {
    vi.mocked(sql).mockResolvedValueOnce([ROW] as never);
    const same = { bankName: 'First National Bank', branchCode: '250655', accountNumber: '62001234567', accountType: 'cheque' as const, accountHolder: 'Acme Credit Ltd' };
    await setCreditorBank('c1', 'e1', 'o1', same, 'admin', ACTOR);
    expect(sql).toHaveBeenCalledTimes(1);
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it('a manager\'s first entry writes, and the audit row holds masked values only', async () => {
    const after = { ...ROW, creditor_bank_name: 'Standard Bank', creditor_branch_code: '051001', creditor_account_number: '10098765432', creditor_account_type: 'savings', creditor_account_holder: null };
    vi.mocked(sql).mockResolvedValueOnce([EMPTY] as never).mockResolvedValueOnce([after] as never);
    const view = await setCreditorBank('c1', 'e1', 'o1', INPUT, 'manager', ACTOR);
    expect(view).toMatchObject({ accountNumber: '…5432', masked: true });
    expect(sqlText().some((t) => /UPDATE payroll_garnishee_orders/.test(t))).toBe(true);
    const audit = JSON.stringify(vi.mocked(logAuditOrThrow).mock.calls[0]![0]);
    expect(audit).toContain('…5432');
    expect(audit).not.toContain('10098765432');
    expect(audit).not.toContain('051001');
  });
});

describe('getCreditorBank', () => {
  it.each([
    ['owner', false, true], ['admin', false, true], ['manager', false, false], ['owner', true, false],
  ] as const)('role %s, masked=%s: full=%s, audited only when full', async (role, masked, full) => {
    vi.mocked(sql).mockResolvedValueOnce([ROW] as never);
    const view = await getCreditorBank('c1', 'e1', 'o1', role, masked, ACTOR);
    expect(view!.masked).toBe(!full);
    expect(vi.mocked(logAuditOrThrow).mock.calls.length).toBe(full ? 1 : 0);
    if (full) expect(vi.mocked(logAuditOrThrow).mock.calls[0]![0]).toMatchObject({ action: 'export', entityType: 'payroll_garnishee_order', entityId: 'o1' });
  });
});
