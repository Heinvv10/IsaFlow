/**
 * The supplier and customer edit pages' save (PUT /api/accounting/suppliers-list and /api/accounting/customers), through
 * the real routes, withAuth and the database:
 *  - the edit is recorded in entity_changes (migration 888's trigger) with the person, the channel and the changed
 *    keys, the same way the MCP update tools are (same service);
 *  - terms are stored as the pair, cleared to NULL / NULL on not_set, and a blank text field is cleared;
 *  - company A cannot edit company B's supplier or customer (404, the row and its history unchanged);
 *  - the same without row-level security: the services' own company_id predicate (the routes above also have RLS behind
 *    them, so they cannot tell a missing predicate from a present one; `inRequest` runs as the table owner);
 *  - a viewer cannot edit; a customer category from another company is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import suppliersList from '../../pages/api/accounting/suppliers-list';
import customers from '../../pages/api/accounting/customers';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { inRequest } from './r035-pr5.helpers';
import { updateSupplier } from '../../src/modules/accounting/services/core/supplierWriteService';
import { updateCustomer } from '../../src/modules/accounting/services/core/customerWriteService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '', other = '', viewer = '';

beforeAll(async () => { [admin, other, viewer] = await members(pool, tokens, 3); });
afterAll(() => cleanupEntityChanges(pool, companies, [admin, other, viewer]));

const company = () => newCompany(pool, [[admin, 'admin'], [viewer, 'viewer']], companies);
const otherCompany = () => newCompany(pool, [[other, 'admin']], companies);
const putSupplier = (user: string, c: string, body: Record<string, unknown>) =>
  callRoute(suppliersList, tokens[user]!, c, 'PUT', body, '/api/accounting/suppliers-list');
const putCustomer = (user: string, c: string, body: Record<string, unknown>) =>
  callRoute(customers, tokens[user]!, c, 'PUT', body, '/api/accounting/customers');

async function newSupplier(c: string, terms: [number, string] | null = [30, 'invoice_days']): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO suppliers(company_id, name, email, phone, payment_terms, payment_terms_type, bank_account_number)
     VALUES($1, 'Edit Co', 'old@x.test', '011 000', $2, $3, '1111222233') RETURNING id`,
    [c, terms?.[0] ?? null, terms?.[1] ?? null]);
  return rows[0].id as string;
}
async function newCustomer(c: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO customers(company_id, name, email, credit_limit, payment_terms, payment_terms_type)
     VALUES($1, 'Edit Cust', 'old@c.test', 5000, 30, 'statement_days') RETURNING id`, [c]);
  return rows[0].id as string;
}
const row = async (table: 'suppliers' | 'customers', id: string) =>
  (await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

describe('PUT supplier', () => {
  it('stores the edit, records it in the entity history under the person, and returns no bank account', async () => {
    const c = await company();
    const id = await newSupplier(c);
    const res = await putSupplier(admin, c, {
      id, name: 'Edit Co (renamed)', email: '', phone: '011 555', payment_terms: 3, payment_terms_type: 'statement_months',
      whatsapp_number: '+27820000000',
    });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(dataOf(res)).toEqual({ id, name: 'Edit Co (renamed)', is_active: true });

    const stored = await row('suppliers', id);
    expect(stored).toMatchObject({
      name: 'Edit Co (renamed)', email: null, phone: '011 555', payment_terms: 3, payment_terms_type: 'statement_months',
      bank_account_number: '1111222233', whatsapp_number: '+27820000000',
    });

    const history = (await changesOf(pool, id)).filter((h) => h.op === 'update');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ company_id: c, entity_type: 'supplier', actor: admin, channel: 'session', db_role: 'app_user' });
    expect(history[0]!.changed).toEqual(expect.arrayContaining(
      ['name', 'email', 'phone', 'payment_terms', 'payment_terms_type', 'whatsapp_number']));
    expect(history[0]!.after).toMatchObject({ payment_terms: 3, payment_terms_type: 'statement_months', email: null });
    expect(history[0]!.before).toMatchObject({ payment_terms: 30, payment_terms_type: 'invoice_days', email: 'old@x.test' });
  });

  it('not_set clears the terms to NULL / NULL (the CHECK holds) and leaves the bank account alone', async () => {
    const c = await company();
    const id = await newSupplier(c);
    const res = await putSupplier(admin, c, { id, payment_terms_type: 'not_set' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await row('suppliers', id)).toMatchObject({ payment_terms: null, payment_terms_type: null, bank_account_number: '1111222233', email: 'old@x.test' });
  });

  it.each([
    ['bank_account_number', '9999888877'], ['bank_name', 'Other Bank'], ['bank_branch_code', '000000'],
    ['bank_account_type', 'savings'], ['bank_account_holder', 'Someone Else'], ['bank_account_number', ''], ['bank_name', null],
  ])('refuses a body with %s (%j): 400 naming it; the row, bank_details_setters and history are unchanged', async (field, value) => {
    const c = await company();
    const id = await newSupplier(c);
    await pool.query('UPDATE suppliers SET bank_name = $2, bank_details_setters = ARRAY[$3::uuid] WHERE id = $1', [id, 'FNB', other]);
    const before = await row('suppliers', id);
    const historyBefore = (await changesOf(pool, id)).length;
    const res = await putSupplier(admin, c, { id, name: 'Edit Co (renamed)', [field]: value });
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toContain(field);
    const after = await row('suppliers', id);
    expect(after).toEqual(before);
    expect(after.bank_details_setters).toEqual([other]);
    expect(after.name).toBe('Edit Co');
    expect(await changesOf(pool, id)).toHaveLength(historyBefore);
  });

  it('an edit that touches no bank detail and no name leaves bank_details_setters alone (the stamp is not reached)', async () => {
    const c = await company();
    const id = await newSupplier(c);
    await pool.query('UPDATE suppliers SET bank_details_setters = ARRAY[$2::uuid] WHERE id = $1', [id, other]);
    const res = await putSupplier(admin, c, { id, email: 'new@x.test', payment_terms_type: 'not_set' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await row('suppliers', id)).toMatchObject({ email: 'new@x.test', bank_account_number: '1111222233', bank_details_setters: [other] });
  });

  it('refuses a bad pair with a 400 and changes nothing', async () => {
    const c = await company();
    const id = await newSupplier(c);
    const res = await putSupplier(admin, c, { id, payment_terms: 30, payment_terms_type: 'net30' });
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toContain('payment_terms_type must be one of');
    expect((await changesOf(pool, id)).filter((h) => h.op === 'update')).toHaveLength(0);
    // withAuth COMMITs a 4xx: re-read the row to see that nothing was written first.
    expect(await row('suppliers', id)).toMatchObject({ name: 'Edit Co', email: 'old@x.test', payment_terms: 30, payment_terms_type: 'invoice_days' });
  });

  it('company A cannot edit company B\'s supplier: 404, the row and its history are untouched', async () => {
    const a = await company();
    const b = await otherCompany();
    const victim = await newSupplier(b);
    const res = await putSupplier(admin, a, { id: victim, name: 'Hijacked', payment_terms_type: 'not_set' });
    expect(res.state.statusCode).toBe(404);
    expect(await row('suppliers', victim)).toMatchObject({
      name: 'Edit Co', bank_account_number: '1111222233', payment_terms: 30, payment_terms_type: 'invoice_days',
    });
    expect((await changesOf(pool, victim)).filter((h) => h.op === 'update')).toHaveLength(0);
  });

  it.each([['opening_balance', 5000], ['openingBalanceDate', '2026-01-01']])(
    'refuses %s on a supplier edit with a 400 naming it; the row is unchanged', async (field, value) => {
      const c = await company();
      const id = await newSupplier(c);
      const res = await putSupplier(admin, c, { id, name: 'Edit Co (renamed)', [field]: value });
      expect(res.state.statusCode).toBe(400);
      expect(messageOf(res)).toContain(field);
      expect((await row('suppliers', id)).name).toBe('Edit Co');
    });

  it('a viewer cannot edit', async () => {
    const c = await company();
    const id = await newSupplier(c);
    const res = await putSupplier(viewer, c, { id, name: 'Viewer was here' });
    expect(res.state.statusCode).toBe(403);
    expect((await row('suppliers', id)).name).toBe('Edit Co');
  });
});

describe('PUT customer', () => {
  it('stores the edit, clears a blank credit limit, and records it in the entity history', async () => {
    const c = await company();
    const id = await newCustomer(c);
    const res = await putCustomer(admin, c, { id, email: '', credit_limit: '', payment_terms: 90, payment_terms_type: 'invoice_days' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await row('customers', id)).toMatchObject({
      email: null, credit_limit: null, payment_terms: 90, payment_terms_type: 'invoice_days', opening_balance: '0.00',
    });
    const history = (await changesOf(pool, id)).filter((h) => h.op === 'update');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ company_id: c, entity_type: 'customer', actor: admin, channel: 'session' });
    expect(history[0]!.changed).toEqual(expect.arrayContaining(['email', 'credit_limit', 'payment_terms', 'payment_terms_type']));
    expect(history[0]!.changed).not.toContain('opening_balance');
  });

  it('not_set clears the terms', async () => {
    const c = await company();
    const id = await newCustomer(c);
    expect((await putCustomer(admin, c, { id, payment_terms_type: 'not_set' })).state.statusCode).toBe(200);
    expect(await row('customers', id)).toMatchObject({ payment_terms: null, payment_terms_type: null });
  });

  it('refuses a category that belongs to another company', async () => {
    const a = await company();
    const b = await otherCompany();
    const id = await newCustomer(a);
    const foreign = (await pool.query("INSERT INTO customer_categories(company_id, name) VALUES($1, 'Theirs') RETURNING id", [b])).rows[0].id as string;
    const res = await putCustomer(admin, a, { id, category_id: foreign });
    expect(res.state.statusCode).toBe(400);
    expect((await row('customers', id)).category_id).toBeNull();
    await pool.query('DELETE FROM customer_categories WHERE company_id = $1', [b]);
  });

  it('a viewer cannot edit a customer', async () => {
    const c = await company();
    const id = await newCustomer(c);
    const res = await putCustomer(viewer, c, { id, name: 'Viewer was here', email: '' });
    expect(res.state.statusCode).toBe(403);
    expect(await row('customers', id)).toMatchObject({ name: 'Edit Cust', email: 'old@c.test' });
    expect((await changesOf(pool, id)).filter((h) => h.op === 'update')).toHaveLength(0);
  });

  it.each([['opening_balance', 5000], ['opening_balance_date', '2026-01-01'], ['openingBalance', 1]])(
    'refuses %s on an edit with a 400 naming it; the row is unchanged', async (field, value) => {
      const c = await company();
      const id = await newCustomer(c);
      const res = await putCustomer(admin, c, { id, name: 'Edit Cust (renamed)', [field]: value });
      expect(res.state.statusCode).toBe(400);
      expect(messageOf(res)).toContain(field);
      expect(await row('customers', id)).toMatchObject({ name: 'Edit Cust', opening_balance: '0.00' });
    });

  it('a bare payment_terms keeps the stored type (statement_days stays statement_days)', async () => {
    const c = await company();
    const id = await newCustomer(c);
    expect((await putCustomer(admin, c, { id, payment_terms: 45 })).state.statusCode).toBe(200);
    expect(await row('customers', id)).toMatchObject({ payment_terms: 45, payment_terms_type: 'statement_days' });
  });

  it('a bare payment_terms on a contact with no terms reads as invoice days', async () => {
    const c = await company();
    const id = await newSupplier(c, null);
    expect((await putSupplier(admin, c, { id, payment_terms: 20 })).state.statusCode).toBe(200);
    expect(await row('suppliers', id)).toMatchObject({ payment_terms: 20, payment_terms_type: 'invoice_days' });
  });

  it('company A cannot edit company B\'s customer: 404, nothing changes', async () => {
    const a = await company();
    const b = await otherCompany();
    const victim = await newCustomer(b);
    const res = await putCustomer(admin, a, { id: victim, name: 'Hijacked', email: '' });
    expect(res.state.statusCode).toBe(404);
    expect(await row('customers', victim)).toMatchObject({ name: 'Edit Cust', email: 'old@c.test' });
    expect((await changesOf(pool, victim)).filter((h) => h.op === 'update')).toHaveLength(0);
  });
});

describe('the services\' company_id predicate on its own (no row-level security: the table owner runs them)', () => {
  it('updateSupplier of company B\'s supplier, asked as company A, finds nothing and changes nothing', async () => {
    const a = await company();
    const b = await otherCompany();
    const victim = await newSupplier(b);
    const out = await inRequest(pool, admin, a, () => updateSupplier(a, victim, { name: 'Hijacked', clear: ['email'] }, admin));
    expect(out).toBeNull();
    expect(await row('suppliers', victim)).toMatchObject({ name: 'Edit Co', email: 'old@x.test' });
  });

  it('updateCustomer of company B\'s customer, asked as company A, finds nothing and changes nothing', async () => {
    const a = await company();
    const b = await otherCompany();
    const victim = await newCustomer(b);
    const out = await inRequest(pool, admin, a, () => updateCustomer(a, victim, { name: 'Hijacked', clear: ['email'] }));
    expect(out).toBeNull();
    expect(await row('customers', victim)).toMatchObject({ name: 'Edit Cust', email: 'old@c.test' });
  });
});
