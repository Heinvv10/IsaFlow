/** BREAKER R2-B (#1670): Customers & AR Approve now refuses a customer credit note, but a customer INVOICE is approved (posted) anyway. */
import { describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';
const C = '11111111-1111-4111-8111-111111111111', U = '99999999-9999-4999-8999-999999999999';
const db = permissionDb();
db.members.set(`${C}:${U}`, 'manager'); db.rows.set(`${C}:${U}:customers`, { can_read: true, can_write: true, can_export: true, can_approve: false });
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, f: () => unknown) => f() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', async (o) => ({ ...(await o<object>()),
  approveCustomerInvoice: vi.fn(async () => ({ id: 'inv-1', status: 'approved' })) }));
import { sql } from '@/lib/neon';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import handler from '../../../pages/api/accounting/customer-invoices-detail';
describe('R2-B', () => {
  it('approving a customer invoice takes Customers & AR Approve, as a customer credit note does', async () => {
    vi.mocked(sql).mockImplementation(permissionSql(db) as never);
    expect(await mayApprove(C, U, 'customers')).toBe(false);
    const req = { method: 'POST', query: {}, body: { id: '77777777-7777-4777-8777-777777777777', action: 'approve' }, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
    const res = { statusCode: 200, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
    await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
    expect(approveCustomerInvoice).not.toHaveBeenCalled();
  });
});
