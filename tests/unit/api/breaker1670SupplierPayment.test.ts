/** BREAKER R2-A (#1670): a single supplier payment is approved by a manager whose Suppliers & AP Approve is unticked,
 * although the same payment through a batch or an approval request is refused (APPROVE_MODULE_BY_DOCUMENT.supplier_payment). */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';
const C = '11111111-1111-4111-8111-111111111111', U = '99999999-9999-4999-8999-999999999999';
const db = permissionDb();
db.members.set(`${C}:${U}`, 'manager'); db.rows.set(`${C}:${U}:suppliers`, { can_read: true, can_write: true, can_export: true, can_approve: false });
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, f: () => unknown) => f() }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentService', () => ({
  approveSupplierPayment: vi.fn(async () => ({ id: 'pay-1', status: 'approved' })), processSupplierPayment: vi.fn() }));
import { sql } from '@/lib/neon';
import { approveSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentService';
import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import handler from '../../../pages/api/accounting/supplier-payments-action';

describe('R2-A', () => {
  it('approve on supplier-payments-action must take Suppliers & AP Approve', async () => {
    vi.mocked(sql).mockImplementation(permissionSql(db) as never);
    expect(await mayApprove(C, U, 'suppliers')).toBe(false);
    const req = { method: 'POST', query: {}, body: { action: 'approve', paymentId: '44444444-4444-4444-8444-444444444444' }, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
    const res = { statusCode: 200, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
    expect(approveSupplierPayment).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
