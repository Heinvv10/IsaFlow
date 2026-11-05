/**
 * POST /api/accounting/default-accounts, the `payroll_net_pay` key: only an owner or admin may name it (security review
 * L1: a manager can approve payroll, so one who could also redirect net pay could do both in a session). A manager gets a
 * 403 BEFORE the transaction opens and nothing is saved; every other key behaves as for any writer; the saving user's id
 * reaches the service (it is the audit row's author).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({ save: vi.fn(async () => undefined), tx: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn('tx')) }));
vi.mock('@/modules/accounting/services/gl/defaultAccountsService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/gl/defaultAccountsService')>()),
  saveDefaultAccountMappings: svc.save,
  readDefaultAccountMappings: vi.fn(async () => ({})),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: svc.tx }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/afterCommit', () => ({ runAfterCommit: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ clearSystemAccountCache: vi.fn() }));

import handler from '../../../pages/api/accounting/default-accounts';

const ID = '21700000-0000-4000-8000-000000000001';

async function post(role: string | undefined, body: Record<string, unknown>): Promise<number> {
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; }, setHeader() { return this; } };
  await (handler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<unknown>)(
    { method: 'POST', body, companyId: 'co-1', companyRole: role, user: { id: 'user-9' } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res.statusCode;
}

beforeEach(() => { svc.save.mockClear(); svc.tx.mockClear(); });

describe('payroll_net_pay is owner/admin only', () => {
  it.each(['owner', 'admin'])('%s may save it, and the saving user reaches the service', async (role) => {
    expect(await post(role, { mappings: { payroll_net_pay: ID }, loaded: { payroll_net_pay: '' } })).toBe(200);
    expect(svc.save).toHaveBeenCalledWith('tx', 'co-1', { payroll_net_pay: ID }, { payroll_net_pay: '' }, 'user-9');
  });

  it.each(['manager', 'accountant', 'viewer', undefined])('%s gets a 403 and nothing is opened or saved', async (role) => {
    expect(await post(role, { mappings: { payroll_net_pay: ID }, loaded: {} })).toBe(403);
    expect(svc.tx).not.toHaveBeenCalled();
    expect(svc.save).not.toHaveBeenCalled();
  });

  it('a manager who names it alongside another key is refused as a whole (nothing saved)', async () => {
    expect(await post('manager', { mappings: { accounts_payable: ID, payroll_net_pay: '' }, loaded: {} })).toBe(403);
    expect(svc.save).not.toHaveBeenCalled();
  });

  it('a manager who clears it (empty) is refused too: clearing moves net pay to the bank', async () => {
    expect(await post('manager', { mappings: { payroll_net_pay: '' }, loaded: {} })).toBe(403);
  });

  it.each(['manager', 'accountant', 'viewer', undefined])('%s gets a 403 for primary_bank too: with payroll_net_pay unset, net pay credits the bank role holder', async (role) => {
    expect(await post(role, { mappings: { primary_bank: ID }, loaded: { primary_bank: '' } })).toBe(403);
    expect(svc.tx).not.toHaveBeenCalled();
    expect(svc.save).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('%s may move primary_bank', async (role) => {
    expect(await post(role, { mappings: { primary_bank: ID }, loaded: { primary_bank: '' } })).toBe(200);
    expect(svc.save).toHaveBeenCalledTimes(1);
  });

  it('a manager naming primary_bank beside another key is refused as a whole', async () => {
    expect(await post('manager', { mappings: { accounts_payable: ID, primary_bank: ID }, loaded: {} })).toBe(403);
    expect(svc.save).not.toHaveBeenCalled();
  });

  it.each(['manager', 'owner'])('the other keys behave as today for a %s', async (role) => {
    expect(await post(role, { mappings: { accounts_payable: ID }, loaded: { accounts_payable: '' } })).toBe(200);
    expect(svc.save).toHaveBeenCalledTimes(1);
  });

  it('an inherited property name is not the key (hasOwn): a body without it is not refused', async () => {
    expect(await post('manager', { mappings: Object.create({ payroll_net_pay: ID }) as Record<string, unknown>, loaded: {} })).toBe(200);
  });
});
