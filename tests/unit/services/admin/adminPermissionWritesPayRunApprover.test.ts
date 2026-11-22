/**
 * #1670 Codex (memberWrites:130), the admin portal's side: withholding Approve, unticking Payroll Approve and a permission reset
 * are judged by the last-other-approver guard (payRunApproverGuard, effective Payroll Approve) before the write, as the company's
 * own User Access writes are; a refusal is PAY_RUN_APPROVER (409) and nothing is written.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    db.calls.push(text);
    return /SELECT role FROM company_users/.test(text) ? [{ role: 'manager' }] : [];
  }),
}));
vi.mock('@/modules/accounting/services/core/payRunApproverGuard', async (orig) => ({
  ...(await orig<object>()), assertPayRunApproverRetained: vi.fn(async () => undefined),
}));

import { assertPayRunApproverRetained, PayRunApproverProtectedError } from '@/modules/accounting/services/core/payRunApproverGuard';
import {
  CompanyMembershipError, resetPermissionsByAdmin, setApproveWithheldByAdmin, setModulePermissionByAdmin,
} from '@/modules/admin/services/companyMembershipService';

const C = '11111111-1111-4111-8111-111111111111';
const U = 'user-1';
const wrote = () => db.calls.some((t) => /UPDATE company_users|INSERT INTO company_user_permissions|DELETE FROM company_user_permissions/.test(t));
const refuseOnce = () => vi.mocked(assertPayRunApproverRetained).mockRejectedValueOnce(new PayRunApproverProtectedError());

beforeEach(() => { db.calls.length = 0; vi.mocked(assertPayRunApproverRetained).mockClear(); });

describe('admin permission writes keep a pending pay run decidable', () => {
  it('withholding asks the guard (approveWithheld) and a refusal is PAY_RUN_APPROVER with nothing written; restoring is not judged', async () => {
    refuseOnce();
    await expect(setApproveWithheldByAdmin(U, C, true)).rejects.toMatchObject({ code: 'PAY_RUN_APPROVER' });
    expect(assertPayRunApproverRetained).toHaveBeenCalledWith(C, U, { approveWithheld: true });
    expect(wrote()).toBe(false);
    vi.mocked(assertPayRunApproverRetained).mockClear();
    await setApproveWithheldByAdmin(U, C, false);
    expect(assertPayRunApproverRetained).not.toHaveBeenCalled();
  });

  it('a Payroll row asks the guard with its Approve; another module does not', async () => {
    refuseOnce();
    await expect(setModulePermissionByAdmin(C, U, 'payroll', { canRead: true, canApprove: false })).rejects.toBeInstanceOf(CompanyMembershipError);
    expect(assertPayRunApproverRetained).toHaveBeenCalledWith(C, U, { payrollRow: { canApprove: false } });
    expect(wrote()).toBe(false);
    vi.mocked(assertPayRunApproverRetained).mockClear();
    await setModulePermissionByAdmin(C, U, 'suppliers', { canApprove: false });
    expect(assertPayRunApproverRetained).not.toHaveBeenCalled();
  });

  it('a reset asks the guard (reset) before deleting', async () => {
    refuseOnce();
    await expect(resetPermissionsByAdmin(C, U)).rejects.toMatchObject({ code: 'PAY_RUN_APPROVER' });
    expect(assertPayRunApproverRetained).toHaveBeenCalledWith(C, U, { payrollRow: 'reset' });
    expect(wrote()).toBe(false);
  });
});
