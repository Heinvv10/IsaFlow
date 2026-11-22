/** BREAKER R2-C (#1670), ported: the create guard compared `post !== true`; now a non-boolean autoPost is refused 400 (zod) on POST and PUT.
 * Original:  the autoPost create guard compares `post !== true`; autoPost "true" passes it and is stored as TRUE by pg. */
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
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/core/recurringTransactionService', async (o) => ({ ...(await o<object>()), createRecurringTemplate: vi.fn(async () => ({ id: 't1' })), updateRecurringTemplate: vi.fn(async () => ({ id: 't1' })) }));
import { sql } from '@/lib/neon';
import { createRecurringTemplate, updateRecurringTemplate } from '@/modules/accounting/services/core/recurringTransactionService';
import handler from '../../../pages/api/accounting/recurring-transactions';
const call = async (method: string, body: unknown) => {
  const req = { method, query: {}, body, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
  const res = { statusCode: 200, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; }, end() { return this; } };
  await (handler as (q: NextApiRequest, s: NextApiResponse) => Promise<unknown>)(req, res as unknown as NextApiResponse);
  return res;
};
describe('R2-C', () => {
  it('create with autoPost "true" is refused like autoPost true', async () => {
    vi.mocked(sql).mockImplementation(permissionSql(db) as never);
    const base = { name: 'Rent', entityType: 'supplier_invoice', templateData: {}, frequency: 'monthly' };
    expect((await call('POST', { ...base, autoPost: true })).statusCode).toBe(403);
    const r = await call('POST', { ...base, autoPost: 'true' });
    expect(r.statusCode).toBe(400); // refused: a non-boolean autoPost is a 400 before the approve rule
    expect(createRecurringTemplate).not.toHaveBeenCalled();
  });
  it('PUT with autoPost 1 is refused', async () => {
    vi.mocked(sql).mockImplementation(permissionSql(db, (t) => t.includes('recurring_transaction_templates') ? [{ entity_type: 'supplier_invoice', auto_post: false }] : []) as never);
    const r = await call('PUT', { id: '55555555-5555-4555-8555-555555555555', autoPost: 1 });
    expect(r.statusCode).toBe(400);
    expect(updateRecurringTemplate).not.toHaveBeenCalled();
  });
});
