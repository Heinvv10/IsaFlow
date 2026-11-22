/**
 * #1656 security fix (TOCTOU): customer-invoices-detail cancel no longer reads the invoice's status before the service
 * takes its row lock to decide whether Approve is needed. The route passes the person's Customers Approve as
 * allowReversal, and the service decides under the lock (customerInvoiceCancelService.test.ts). Here: the route reads
 * nothing but the permission, passes allowReversal truthfully, and answers the service's refusal 403.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCancelService', async (orig) => ({ ...(await orig<object>()), cancelCustomerInvoice: vi.fn() }));

import { sql } from '@/lib/neon';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { ApprovePermissionError } from '@/modules/accounting/services/core/approvePermission';
import handler from '../../../pages/api/accounting/customer-invoices-detail';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const ID = '66666666-6666-4666-8666-666666666666';
let db = permissionDb();

async function cancel() {
  const req = { method: 'POST', query: {}, body: { id: ID, action: 'cancel' }, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
  const res = { statusCode: 200, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  await handler(req, res as unknown as NextApiResponse);
  return res;
}
const failOnOtherSql = (text: string) => { throw new Error(`the route read something before the service lock: ${text.slice(0, 80)}`); };

beforeEach(() => {
  vi.clearAllMocks();
  db = permissionDb();
  vi.mocked(sql).mockImplementation(permissionSql(db, failOnOtherSql) as never);
  vi.mocked(cancelCustomerInvoice).mockResolvedValue({ id: ID, reversedJournalEntryId: null });
});

describe('customer-invoices-detail cancel', () => {
  it('a manager with Approve unticked: the service is called with allowReversal=false, and the route read no invoice status', async () => {
    db.members.set(`${C}:${U}`, 'manager');
    db.rows.set(`${C}:${U}:customers`, { can_read: true, can_write: true, can_approve: false });
    const res = await cancel();
    expect(res.statusCode).toBe(200);
    expect(cancelCustomerInvoice).toHaveBeenCalledWith(C, ID, U, { allowReversal: false });
    expect(db.reads).toEqual([{ companyId: C, userId: U, moduleKey: 'customers' }]);
  });

  it('a person with Approve: allowReversal=true', async () => {
    db.members.set(`${C}:${U}`, 'manager');
    await cancel();
    expect(cancelCustomerInvoice).toHaveBeenCalledWith(C, ID, U, { allowReversal: true });
  });

  it('the service refuses a journalled invoice found under its lock (the row became posted after the route began): 403', async () => {
    db.members.set(`${C}:${U}`, 'manager');
    db.rows.set(`${C}:${U}:customers`, { can_read: true, can_write: true, can_approve: false });
    vi.mocked(cancelCustomerInvoice).mockRejectedValue(new ApprovePermissionError('customers', 'customer invoices'));
    const res = await cancel();
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.sent)).toMatch(/permission to approve customer invoices/);
  });
});
