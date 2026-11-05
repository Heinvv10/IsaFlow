/**
 * PUT /api/accounting/suppliers-list and PUT /api/accounting/customers — the edit pages' save. The real handlers and the
 * real write services run; only the database and the auth wrappers are stubbed. What is asserted is what reaches the
 * UPDATE: the request's company (never one named in the body), the user, cleared fields, the terms, and what comes back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const db = vi.hoisted(() => ({ calls: [] as { text: string; values: unknown[] }[], rows: [] as Record<string, unknown>[] }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    db.calls.push({ text, values });
    return text.includes('UPDATE suppliers') || text.includes('UPDATE customers') ? db.rows : [];
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ listSuppliers: vi.fn(), listCustomers: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierPaymentAuthors', () => ({
  bankDetailsChange: vi.fn(() => 'none'), hasBankDetails: vi.fn(() => false),
  lockSupplierBankDetails: vi.fn(async () => null), recordBankDetailsSetter: vi.fn(),
}));

import suppliers from '../../../pages/api/accounting/suppliers-list';
import customers from '../../../pages/api/accounting/customers';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '99999999-9999-4999-8999-999999999999';
const ID = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function response() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() } as unknown as NextApiResponse;
}
const put = (body: unknown) => ({ method: 'PUT', companyId: COMPANY_A, user: { id: USER }, query: {}, body }) as unknown as NextApiRequest;
const status = (res: NextApiResponse) => vi.mocked(res.status).mock.calls[0]?.[0];
const sent = (res: NextApiResponse) => vi.mocked(res.json).mock.calls[0]?.[0] as { data?: Record<string, unknown> };
const update = () => db.calls.find((c) => c.text.includes('UPDATE suppliers') || c.text.includes('UPDATE customers'));

beforeEach(() => { vi.clearAllMocks(); db.calls = []; db.rows = [{ id: ID, name: 'Acme', is_active: true, bank_account_number: '62012345678' }]; });

describe.each([
  ['supplier', suppliers, 'Supplier'],
  ['customer', customers, 'Customer'],
] as const)('PUT %s', (_who, handler, label) => {
  it('is scoped to the request company: the id and company are the last two parameters, a body company_id is ignored', async () => {
    const res = response();
    await handler(put({ id: ID, name: 'Acme', company_id: COMPANY_B }), res);
    expect(status(res)).toBe(200);
    const values = update()!.values;
    expect(values.slice(-2)).toEqual([ID, COMPANY_A]);
    expect(values).not.toContain(COMPANY_B);
    expect(update()!.text).toMatch(/AND\s+company_id\s*=/);
  });

  it('answers 404 when the row is not in this company (the UPDATE found nothing)', async () => {
    db.rows = [];
    const res = response();
    await handler(put({ id: ID, name: 'Acme' }), res);
    expect(status(res)).toBe(404);
    expect(JSON.stringify(sent(res))).toContain(label);
  });

  it.each([[{ name: 'x' }], [{ id: 'nope' }], [{ id: '------------------------------------' }], [null]])(
    'refuses a missing or non-UUID id (%j) before any SQL', async (body) => {
      const res = response();
      await handler(put(body), res);
      expect(status(res)).toBe(400);
      expect(db.calls).toHaveLength(0);
    },
  );

  it.each([
    ['a type without its number', { payment_terms_type: 'statement_days' }],
    ['an unknown type', { payment_terms: 30, payment_terms_type: 'net30' }],
    ['a negative number', { payment_terms: -1 }],
    ['a name over 255 characters', { name: 'n'.repeat(256) }],
    ['a blank name', { name: '  ' }],
  ])('validates as create does: %s is a 400 before any SQL', async (_why, fields) => {
    const res = response();
    await handler(put({ id: ID, ...fields }), res);
    expect(status(res)).toBe(400);
    expect(db.calls).toHaveLength(0);
  });

  it('returns only id, name and is_active (never the stored row)', async () => {
    const res = response();
    await handler(put({ id: ID, name: 'Acme' }), res);
    expect(sent(res).data).toEqual({ id: ID, name: 'Acme', is_active: true });
  });
});

describe('PUT supplier: what reaches the UPDATE', () => {
  // The supplier UPDATE binds name, then a (cleared?, value) pair per clearable text column: company_name 1-2,
  // email 3-4, ... terms mode/days/mode/type at 17-20.
  it('clears a text field sent blank and leaves one that is not sent', async () => {
    await suppliers(put({ id: ID, email: '', phone: '011 555' }), response());
    const v = update()!.values;
    expect(v[3]).toBe(true);   // email: cleared
    expect(v[4]).toBeNull();
    expect(v[5]).toBe(false);  // phone: set, not cleared
    expect(v[6]).toBe('011 555');
    expect(v[1]).toBe(false);  // company_name: not sent, left alone
  });

  it('sets terms as a pair and clears them on not_set', async () => {
    await suppliers(put({ id: ID, payment_terms: 3, payment_terms_type: 'statement_months' }), response());
    expect(update()!.values.slice(17, 22)).toEqual(['set', 3, 3, 'set', 'statement_months']);
    db.calls = [];
    await suppliers(put({ id: ID, payment_terms_type: 'not_set' }), response());
    expect(update()!.values.slice(17, 22)).toEqual(['clear', null, null, 'clear', null]);
  });

  // Hein, 2026-11-05: the edit never changes bank details. Refused by name, never ignored, before any SQL, so the
  // bank-details stamp cannot be reached.
  it.each([
    ['bank_account_number', '62000000001'], ['bank_name', 'FNB'], ['bank_branch_code', '250655'], ['bank_account_type', 'savings'],
    ['bank_account_holder', 'Someone'], ['bankAccountNumber', '62000000001'], ['bank_account_number', ''], ['bank_name', null],
  ])('a body with %s (%j) is a 400 naming the field, and nothing is written', async (field, value) => {
    const res = response();
    await suppliers(put({ id: ID, name: 'Acme', [field]: value }), res);
    expect(status(res)).toBe(400);
    expect(JSON.stringify(sent(res))).toContain(field);
    expect(db.calls).toHaveLength(0);
  });

  it('names every bank field sent, not just the first', async () => {
    const res = response();
    await suppliers(put({ id: ID, bank_name: 'FNB', bank_account_number: '1' }), res);
    expect(JSON.stringify(sent(res))).toContain('bank_name, bank_account_number');
  });

  it('the UPDATE it does run has no bank column bound to anything but its own value (no CASE clear)', async () => {
    await suppliers(put({ id: ID, name: 'Acme' }), response());
    expect(update()!.text).not.toMatch(/bank_\w+\s*= CASE/);
  });
});

describe('PUT customer: what reaches the UPDATE', () => {
  it('clears a blank credit limit and email, and the UPDATE never touches the opening balance', async () => {
    await customers(put({ id: ID, email: '', credit_limit: '' }), response());
    const { text, values } = update()!;
    expect(values[1]).toBe(true);   // email cleared
    expect(values[26]).toBe(true);  // credit_limit cleared
    expect(text).not.toContain('opening_balance');
  });

  it.each([['opening_balance', 5000], ['opening_balance_date', '2026-01-01'], ['openingBalance', 1]])(
    'an edit naming %s is a 400 naming it, before any SQL (an opening balance is set once and corrected with a journal)',
    async (field, value) => {
      const res = response();
      await customers(put({ id: ID, name: 'Acme', [field]: value }), res);
      expect(status(res)).toBe(400);
      expect(JSON.stringify(sent(res))).toContain(field);
      expect(db.calls).toHaveLength(0);
    });

  it.each([['credit_limit', 'abc'], ['default_discount', 'NaN'], ['credit_limit', {}]])(
    '%s = %j is a 400 (not a NaN bound into the UPDATE)', async (field, value) => {
      const res = response();
      await customers(put({ id: ID, [field]: value }), res);
      expect(status(res)).toBe(400);
      expect(db.calls).toHaveLength(0);
    });

  it.each([[null], ['text'], [[1, 2]]])('a POST with body %j is a 400, not a TypeError 500', async (body) => {
    const res = response();
    await customers({ method: 'POST', companyId: COMPANY_A, user: { id: USER }, query: {}, body } as unknown as NextApiRequest, res);
    expect(status(res)).toBe(400);
    expect(db.calls).toHaveLength(0);
  });
});
