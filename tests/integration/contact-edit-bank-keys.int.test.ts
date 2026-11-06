/**
 * The supplier edit (PUT /api/accounting/suppliers-list) never changes bank details, whatever the body names. The key
 * list is not written here: every key `supplierInputFromBody` READS is recorded by running it over a recording body, so
 * a bank key added to the parser tomorrow is sent to the route by this test without anyone listing it.
 *  - a bank-ish key the parser reads: the PUT is a 400 naming it, and the row, bank_details_setters and history are unchanged;
 *  - a bank-ish key the parser does not read (iban, account_number, branch_code, payee, ...): refused or ignored, and the
 *    row's bank columns, bank_details_setters and history are unchanged either way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import suppliersList from '../../pages/api/accounting/suppliers-list';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute } from './r035-approval.helpers';
import { messageOf } from './r035-pr2.helpers';
import { changesOf, cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { supplierInputFromBody } from '../../src/modules/accounting/services/core/contactRequestInput';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '', other = '';

beforeAll(async () => { [admin, other] = await members(pool, tokens, 2); });
afterAll(() => cleanupEntityChanges(pool, companies, [admin, other]));

const BANKISH = /bank|iban|account|branch|payee|swift|sort_?code|routing/i;

/** Every key the create parser reads, recorded by reading through a Proxy (get and `in`). */
function keysRead(): string[] {
  const seen = new Set<string>();
  const body = new Proxy({}, {
    get: (_t, k) => { if (typeof k === 'string') seen.add(k); return undefined; },
    has: (_t, k) => { if (typeof k === 'string') seen.add(k); return false; },
  });
  supplierInputFromBody(body);
  return [...seen];
}
const READ = keysRead();
const UNREAD_BANKISH = ['iban', 'account_number', 'accountNumber', 'branch_code', 'branchCode', 'payee', 'payee_name', 'swift', 'sort_code', 'routing_number'];

async function newSupplier(c: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO suppliers(company_id, name, email, payment_terms, payment_terms_type, bank_name, bank_account_number, bank_branch_code, bank_details_setters)
     VALUES($1, 'Edit Co', 'old@x.test', 30, 'invoice_days', 'FNB', '1111222233', '250655', ARRAY[$2::uuid]) RETURNING id`, [c, other]);
  return rows[0].id as string;
}
const row = async (id: string) => (await pool.query('SELECT * FROM suppliers WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
const put = (c: string, body: Record<string, unknown>) => callRoute(suppliersList, tokens[admin]!, c, 'PUT', body, '/api/accounting/suppliers-list');

describe('the recorded key list is real', () => {
  it('records the keys the parser reads, including the bank ones', () => {
    expect(READ).toEqual(expect.arrayContaining(['name', 'email', 'payment_terms', 'bank_name', 'bank_account_number']));
    expect(READ.filter((k) => BANKISH.test(k)).length).toBeGreaterThanOrEqual(4);
  });
});

describe('PUT supplier with a bank-ish key', () => {
  it.each(READ.filter((k) => BANKISH.test(k)).map((k) => [k]))('the parser reads %s: 400 naming it, nothing changes', async (key) => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    const id = await newSupplier(c);
    const before = await row(id);
    const historyBefore = (await changesOf(pool, id)).length;
    const res = await put(c, { id, name: 'Edit Co (renamed)', [key]: 'X-123' });
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
    expect(messageOf(res)).toContain(key);
    expect(await row(id)).toEqual(before);
    expect(await changesOf(pool, id)).toHaveLength(historyBefore);
  });

  it.each(UNREAD_BANKISH.map((k) => [k]))('%s (not read by the parser): refused or ignored, the bank columns and the stamp never move', async (key) => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    const id = await newSupplier(c);
    const before = await row(id);
    const res = await put(c, { id, email: 'new@x.test', [key]: 'X-123' });
    expect([200, 400]).toContain(res.state.statusCode);
    const after = await row(id);
    for (const col of ['bank_name', 'bank_account_number', 'bank_branch_code', 'bank_account_type', 'bank_details_setters']) {
      expect(after[col], col).toEqual(before[col]);
    }
    expect(JSON.stringify(after)).not.toContain('X-123');
  });
});
