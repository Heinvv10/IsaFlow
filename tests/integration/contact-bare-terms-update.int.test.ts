/**
 * An update that names only the NUMBER of the payment terms (MCP update_customer / update_supplier with payment_terms: 14)
 * keeps the stored type only when it is one the code reads (the three canonical types, or the legacy days / end_of_month).
 * Any other stored type (a customer's free-text 'weekly', an empty string, none) becomes invoice_days: keeping 'weekly'
 * would store (14, 'weekly'), which readTerms treats as not set, so the 14 would be silently ignored.
 * Through the real services on both tables; the stored row is read back.
 * Since migration 963 a contact can only hold not set or N with one of the three canonical types (the shape CHECK), so
 * those are the stored states left to test; the legacy and free-text types cannot be stored any more.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanupEntityChanges, members, newCompany } from './entity-changes.helpers';
import { inRequest } from './r035-pr5.helpers';
import { updateSupplier } from '../../src/modules/accounting/services/core/supplierWriteService';
import { updateCustomer } from '../../src/modules/accounting/services/core/customerWriteService';
import { readTerms } from '../../src/modules/accounting/services/shared/paymentTerms';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let admin = '';

beforeAll(async () => { [admin] = await members(pool, tokens, 1); });
afterAll(() => cleanupEntityChanges(pool, companies, [admin]));

const STORED: [string | null, string][] = [
  [null, 'invoice_days'], ['invoice_days', 'invoice_days'], ['statement_days', 'statement_days'], ['statement_months', 'statement_months'],
];

describe.each(['suppliers', 'customers'] as const)('a bare payment_terms on %s', (table) => {
  it.each(STORED)('stored type %j becomes %j, and the 14 is read as terms', async (stored, expected) => {
    const c = await newCompany(pool, [[admin, 'admin']], companies);
    const { rows: made } = await pool.query(
      `INSERT INTO ${table}(company_id, name, payment_terms, payment_terms_type) VALUES($1, 'Bare', $2, $3) RETURNING id`,
      [c, stored === null ? null : 30, stored]);
    const id = made[0].id as string;
    await inRequest(pool, admin, c, () => table === 'suppliers'
      ? updateSupplier(c, id, { paymentTerms: 14 }, admin)
      : updateCustomer(c, id, { paymentTerms: 14 }));
    const { rows } = await pool.query(`SELECT payment_terms, payment_terms_type FROM ${table} WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ payment_terms: 14, payment_terms_type: expected });
    expect(readTerms(rows[0].payment_terms, rows[0].payment_terms_type)?.days).toBe(14);
  });
});
