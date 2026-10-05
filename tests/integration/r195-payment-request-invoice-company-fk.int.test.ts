/**
 * R-195: a Paystack or Stitch payment request may only name an invoice of its OWN company.
 *
 * Before migration 854 `customer_invoice_id` was a single-column FK, so a request in company B
 * could name company C's invoice (RLS admits every company the user belongs to). The archive
 * skips only invoices a request of the same company references (R-186), so C's run deleted the
 * invoice, the SET NULL hit B's row and paystack_pr_invoice_has_invoice /
 * stitch_pr_invoice_has_invoice failed C's whole run on 23514. 854 adds a composite FK
 * (customer_invoice_id, company_id) -> customer_invoices(id, company_id).
 *
 * Pinned here, on real Postgres as app_user:
 *   · a cross-company request is refused at insert (23503), for both gateways;
 *   · a same-company request is accepted;
 *   · ON DELETE is unchanged: an invoice-purpose request still blocks the delete on 23514, and a
 *     request of another purpose loses only its invoice id (SET NULL (customer_invoice_id)), never
 *     its company_id;
 *   · the migration validates on a clean DB, and on a DB holding a forged row leaves the FK
 *     NOT VALID and the row untouched. The DDL runs in a transaction that is rolled back.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { addCompany, addInvoice, addPaystackRequest, addStitchRequest, addUser, cleanup, pool, user } from './r195-payment-request.helpers';

assertDisposable();

const migration = () => readFileSync(
  path.join(__dirname, '../../scripts/migrations/sql/854_payment_request_invoice_company_fk.sql'), 'utf8');

/** The user belongs to both: RLS alone admits B's request naming C's invoice. */
const coB = randomUUID();
const coC = randomUUID();
const companies = [coB, coC];

const GATEWAYS = {
  paystack: { table: 'paystack_payment_requests', fk: 'paystack_payment_requests_invoice_company_fkey',
    check: 'paystack_pr_invoice_has_invoice', otherPurpose: 'authorization', ref: 'paystack_reference' },
  stitch: { table: 'stitch_payment_requests', fk: 'stitch_payment_requests_invoice_company_fkey',
    check: 'stitch_pr_invoice_has_invoice', otherPurpose: 'mandate_authorisation', ref: 'external_reference' },
} as const;
type Gateway = keyof typeof GATEWAYS;

interface Outcome { id?: string; code?: string; constraint?: string }

/** Inserts a request as app_user with the withAuth GUCs for `companyId`, and commits. */
async function insertAsAppUser(gateway: Gateway, companyId: string, invoiceId: string,
  purpose = 'customer_invoice'): Promise<Outcome> {
  const g = GATEWAYS[gateway];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const id = (await client.query(
      `INSERT INTO ${g.table}(company_id,purpose,customer_invoice_id,${g.ref},amount_cents)
       VALUES($1,$2,$3,$4,10000) RETURNING id`,
      [companyId, purpose, invoiceId, `r195-${randomUUID()}`])).rows[0]!.id as string;
    await client.query('COMMIT');
    return { id };
  } catch (err) {
    await client.query('ROLLBACK');
    return { code: (err as { code?: string }).code, constraint: (err as { constraint?: string }).constraint };
  } finally {
    client.release();
  }
}

async function deleteInvoice(invoiceId: string): Promise<Outcome> {
  try {
    await pool.query('DELETE FROM customer_invoices WHERE id = $1', [invoiceId]);
    return {};
  } catch (err) {
    return { code: (err as { code?: string }).code, constraint: (err as { constraint?: string }).constraint };
  }
}

const constraintState = async (db: PoolClient, name: string) => (await db.query(
  'SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [name])).rows;

const FK_DEF = 'FOREIGN KEY (customer_invoice_id, company_id) REFERENCES customer_invoices(id, company_id) ON DELETE SET NULL (customer_invoice_id)';

beforeAll(async () => {
  await addUser();
  for (const id of companies) await addCompany(id, true);
});

afterAll(async () => { await cleanup(companies); });

describe.each(['paystack', 'stitch'] as const)('R-195 %s: request and invoice share a company', (gateway) => {
  const g = GATEWAYS[gateway];

  it('a request in company B naming company C\'s invoice is refused at insert (23503)', async () => {
    const invoice = await addInvoice(coC, 'paid');
    const out = await insertAsAppUser(gateway, coB, invoice);
    expect(out, 'company B\'s request was stored against company C\'s invoice').toEqual({ code: '23503', constraint: g.fk });
    const rows = await pool.query(`SELECT id FROM ${g.table} WHERE customer_invoice_id = $1`, [invoice]);
    expect(rows.rows).toEqual([]);
  });

  it('a request naming its own company\'s invoice is accepted', async () => {
    const invoice = await addInvoice(coB, 'paid');
    const out = await insertAsAppUser(gateway, coB, invoice);
    expect(out.code).toBeUndefined();
    const row = (await pool.query(`SELECT company_id, customer_invoice_id FROM ${g.table} WHERE id = $1`, [out.id])).rows;
    expect(row).toEqual([{ company_id: coB, customer_invoice_id: invoice }]);
  });

  it('ON DELETE unchanged: an invoice-purpose request still blocks the delete on 23514', async () => {
    const invoice = await addInvoice(coB, 'paid');
    await (gateway === 'paystack' ? addPaystackRequest : addStitchRequest)(coB, invoice);
    expect(await deleteInvoice(invoice)).toEqual({ code: '23514', constraint: g.check });
    expect((await pool.query('SELECT id FROM customer_invoices WHERE id = $1', [invoice])).rows).toEqual([{ id: invoice }]);
  });

  it('ON DELETE unchanged: a request of another purpose loses only its invoice id, never its company', async () => {
    const invoice = await addInvoice(coB, 'paid');
    const out = await insertAsAppUser(gateway, coB, invoice, g.otherPurpose);
    expect(out.code).toBeUndefined();
    expect(await deleteInvoice(invoice)).toEqual({});
    const row = (await pool.query(`SELECT company_id, customer_invoice_id FROM ${g.table} WHERE id = $1`, [out.id])).rows;
    expect(row).toEqual([{ company_id: coB, customer_invoice_id: null }]);
  });

  // The single-column FK is kept. RI triggers fire in an unspecified order (name order, a text
  // compare of OID-based names); when the kept FK's SET NULL fires first it hides a composite FK that
  // nulls company_id too. Without it, the composite FK alone must give the same outcome.
  it('the composite FK alone (single-column FK dropped, rolled back) keeps company_id on delete', async () => {
    const invoice = await addInvoice(coB, 'paid');
    const other = await insertAsAppUser(gateway, coB, invoice, g.otherPurpose);
    expect(other.code).toBeUndefined();
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`ALTER TABLE ${g.table} DROP CONSTRAINT ${g.table}_customer_invoice_id_fkey`);
      await db.query('DELETE FROM customer_invoices WHERE id = $1', [invoice]);
      const row = (await db.query(`SELECT company_id, customer_invoice_id FROM ${g.table} WHERE id = $1`, [other.id])).rows;
      expect(row).toEqual([{ company_id: coB, customer_invoice_id: null }]);
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });
});

describe('R-195 migration 854', () => {
  it('on a clean DB: adds the unique key and both FKs, validated; run again it changes nothing', async () => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      for (const g of Object.values(GATEWAYS)) await db.query(`ALTER TABLE ${g.table} DROP CONSTRAINT IF EXISTS ${g.fk}`);
      await db.query('ALTER TABLE customer_invoices DROP CONSTRAINT IF EXISTS customer_invoices_id_company_id_key');
      for (let run = 0; run < 2; run++) {
        await db.query(migration());
        const timeouts = (await db.query(
          "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement")).rows;
        expect(timeouts, 'the migration does not bound its lock wait and its run').toEqual([{ lock: '5s', statement: '2min' }]);
        expect(await constraintState(db, 'customer_invoices_id_company_id_key'))
          .toEqual([{ convalidated: true, def: 'UNIQUE (id, company_id)' }]);
        for (const g of Object.values(GATEWAYS)) {
          expect(await constraintState(db, g.fk), g.fk).toEqual([{ convalidated: true, def: FK_DEF }]);
        }
      }
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });

  it.each(['paystack', 'stitch'] as const)('with a forged cross-company %s row: that FK stays NOT VALID, the row is untouched',
    async (gateway) => {
      const g = GATEWAYS[gateway];
      const other = GATEWAYS[gateway === 'paystack' ? 'stitch' : 'paystack'];
      const invoice = await addInvoice(coC, 'paid');
      const db = await pool.connect();
      const notices: string[] = [];
      db.on('notice', (n) => { notices.push(n.message ?? ''); });
      try {
        await db.query('BEGIN');
        for (const x of Object.values(GATEWAYS)) await db.query(`ALTER TABLE ${x.table} DROP CONSTRAINT IF EXISTS ${x.fk}`);
        const forged = (await db.query(
          `INSERT INTO ${g.table}(company_id,purpose,customer_invoice_id,${g.ref},amount_cents)
           VALUES($1,'customer_invoice',$2,$3,10000) RETURNING id, company_id, customer_invoice_id`,
          [coB, invoice, `r195-${randomUUID()}`])).rows[0]!;
        await db.query(migration());
        expect(await constraintState(db, g.fk)).toEqual([{ convalidated: false, def: `${FK_DEF} NOT VALID` }]);
        expect(await constraintState(db, other.fk)).toEqual([{ convalidated: true, def: FK_DEF }]);
        expect(notices.some((m) => m.includes(g.fk) && /\b1\b/.test(m)), notices.join(' | ')).toBe(true);
        const after = (await db.query(`SELECT id, company_id, customer_invoice_id FROM ${g.table} WHERE id = $1`, [forged.id])).rows;
        expect(after).toEqual([forged]);
      } finally {
        await db.query('ROLLBACK');
        db.release();
      }
    });
});
