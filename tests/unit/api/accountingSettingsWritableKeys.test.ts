/**
 * PUT /api/accounting/accounting-settings is the generic settings writer. It writes only the keys the app's pages use
 * through it; a row a service owns and validates is refused with a 400. `accounting_default_accounts` holds the Default
 * Accounts mappings (and where payroll net pay is credited): written here as free text it bypassed the save's rules and
 * stale-page check, and a non-JSON value stopped every payroll calculation of the company (ledger review 2026-11-05).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const svc = vi.hoisted(() => ({ setSetting: vi.fn(async () => undefined), getSetting: vi.fn(async () => 'ZAR') }));
vi.mock('@/modules/accounting/services/core/currencyService', () => ({ setSetting: svc.setSetting, getSetting: svc.getSetting }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));

import handler from '../../../pages/api/accounting/accounting-settings';

async function put(body: Record<string, unknown>): Promise<number> {
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json() { return this; }, setHeader() { return this; } };
  await (handler as unknown as (q: NextApiRequest, r: NextApiResponse) => Promise<unknown>)(
    { method: 'PUT', body, companyId: 'co-1', user: { id: 'u1' } } as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res.statusCode;
}

beforeEach(() => { svc.setSetting.mockClear(); });

describe('the keys the app\'s own pages write still work', () => {
  it.each(['reporting_currency', 'enable_cost_centres', 'enable_business_units', 'document_display_fields'])('%s', async (key) => {
    expect(await put({ key, value: 'x' })).toBe(200);
    expect(svc.setSetting).toHaveBeenCalledWith(key, 'x', 'u1', 'co-1');
  });
});

describe('everything else is a 400 and nothing is written', () => {
  it.each([
    ['accounting_default_accounts', 'not json'],
    ['accounting_default_accounts', JSON.stringify({ payroll_net_pay: '21700000-0000-4000-8000-000000000001' })],
    ['vat_rate', '0'],
    ['Accounting_Default_Accounts', 'x'],
    [['accounting_default_accounts'], 'x'],
    [{ toString: () => 'accounting_default_accounts' }, 'x'],
  ])('%j', async (key, value) => {
    expect(await put({ key, value })).toBe(400);
    expect(svc.setSetting).not.toHaveBeenCalled();
  });
});
