/**
 * WP7: save_selection with an account must name one of THIS company's GL accounts: a foreign or malformed id is a 400
 * before the UPDATE (the suggestion is read back with the account's code and name joined on it). getRules joins its
 * account within the rule's company.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiResponse } from 'next';

const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (fn: unknown) => fn, withWriteAccess: (fn: unknown) => fn }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(sqlMock, { unsafe: (s: string) => s }) }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ assertCustomerInCompany: vi.fn(), assertSupplierInCompany: vi.fn() }));

import handler from '../../../pages/api/accounting/bank-transactions-action';
import { getRules } from '@/modules/accounting/services/bank/bankRulesService';

const COMPANY = '00000000-0000-4000-8000-000000000001';
const TX = '00000000-0000-4000-8000-000000000003';
const GL = '00000000-0000-4000-8000-000000000009';
const text = (c: unknown[]) => (c[0] as string[]).join('?');

async function save(entity: string | null) {
  const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; }, json: vi.fn(), setHeader: vi.fn() };
  await handler({ method: 'POST', companyId: COMPANY, user: { id: 'u' }, body: { action: 'save_selection', bankTransactionId: TX, selectionType: 'account', ...(entity === null ? {} : { selectionEntityId: entity }) } } as never, res as unknown as NextApiResponse);
  return res.statusCode;
}
const updated = () => sqlMock.mock.calls.some((c) => text(c).includes('UPDATE bank_transactions'));

describe('save_selection, account', () => {
  beforeEach(() => {
    sqlMock.mockReset().mockImplementation(async (strings: string[]) => {
      const t = strings.join('?');
      if (t.includes('FROM gl_accounts')) return [{ ok: 1 }];
      if (t.includes('feed_state')) return [{ feed_state: 'posted' }];
      return [];
    });
  });

  it("an account of another company is a 400 and the line is not touched", async () => {
    sqlMock.mockImplementation(async (strings: string[]) => (strings.join('?').includes('FROM gl_accounts') ? [] : [{ feed_state: 'posted' }]));
    expect(await save(GL)).toBe(400);
    expect(updated()).toBe(false);
  });

  it.each(['not-a-uuid', "x' OR 1=1 --"])('a malformed account id %s is refused (422, the body schema) without a query', async (bad) => {
    expect(await save(bad)).toBe(422);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it("the check is made in the caller's company", async () => {
    expect(await save(GL)).toBe(200);
    const check = sqlMock.mock.calls.find((c) => text(c).includes('FROM gl_accounts'))!;
    expect(text(check)).toMatch(/id = \?::UUID AND company_id = \?::UUID/);
    expect(check.slice(1)).toEqual([GL, COMPANY]);
    expect(updated()).toBe(true);
  });

  it('clearing the account (no entity id) needs no check', async () => {
    expect(await save(null)).toBe(200);
    expect(sqlMock.mock.calls.some((c) => text(c).includes('FROM gl_accounts'))).toBe(false);
  });
});

describe('getRules', () => {
  it("joins each rule's GL account within the rule's company", async () => {
    sqlMock.mockReset().mockResolvedValue([]);
    await getRules(COMPANY);
    const q = text(sqlMock.mock.calls[0]!);
    expect(q).toMatch(/LEFT JOIN gl_accounts ga ON ga\.id = r\.gl_account_id AND ga\.company_id = r\.company_id/);
    expect(q).toMatch(/LEFT JOIN suppliers s ON s\.id = r\.supplier_id AND s\.company_id = r\.company_id/);
    expect(q).toMatch(/LEFT JOIN customers c ON c\.id = r\.client_id AND c\.company_id = r\.company_id/);
    // every join in the statement is fenced to the rule's company
    const joins = q.match(/LEFT JOIN \w+ \w+ ON [^\n]+/g) ?? [];
    expect(joins.length).toBeGreaterThanOrEqual(3);
    for (const j of joins) expect(j, j).toMatch(/company_id = r\.company_id/);
  });
});
