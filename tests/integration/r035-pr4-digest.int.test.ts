/**
 * R-035 PR4: what an approval of a CUSTOMER INVOICE vouches for — the
 * customer_invoice branch of approval_document_digest() (migration 865) — and
 * proof that replacing the function left every earlier branch (the supplier
 * invoice from 708, both credit-note types from 862), and their authors, as
 * 862 defined them.
 *
 * Every hashed header and line column moves the digest; every excluded column
 * (status, notes, due date, billing period, payment / email / portal / PDF /
 * VAT-declared / external / actor bookkeeping, timestamps, a line's
 * time_entry_id) does not. Deleting the lines and re-inserting identical ones
 * keeps it (Q9): line ids and created_at values are not content. A
 * soft-deleted invoice, or another company's, digests to NULL.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, enableFxDocuments, plantBill } from './r035-approval.helpers';
import { plantNote } from './r035-pr3.helpers';
import { cleanupPr4, digestOf, invoiceCompany, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let user = '';
let other = '';

beforeAll(async () => {
  user = await createUser(pool, tokens);
  other = await createUser(pool, tokens);
});
afterAll(() => cleanupPr4(pool, companies, [user, other]));

const company = () => invoiceCompany(pool, [[user, 'owner'], [other, 'admin']], companies);

/** Set one column to a new value, read the digest, put the old value back. */
async function digestWith(c: string, table: 'customer_invoices' | 'customer_invoice_items', where: string,
  id: string, invoiceId: string, column: string, value: unknown): Promise<string | null> {
  const before = (await pool.query(`SELECT ${column} AS v FROM ${table} WHERE ${where} = $1`, [id])).rows[0].v;
  await pool.query(`UPDATE ${table} SET ${column} = $2 WHERE ${where} = $1`, [id, value]);
  const moved = await digestOf(pool, c, invoiceId);
  await pool.query(`UPDATE ${table} SET ${column} = $2 WHERE ${where} = $1`, [id, before]);
  return moved;
}

const firstLine = async (invoiceId: string) => (await pool.query(
  "SELECT id FROM customer_invoice_items WHERE invoice_id = $1 AND description = 'Line A'", [invoiceId])).rows[0].id as string;

describe('the customer invoice digest', () => {
  it('is a sha256 for the invoice, NULL for another company, a soft-deleted invoice, or another type', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, user);
    expect(await digestOf(pool, c, inv.id)).toMatch(/^[0-9a-f]{64}$/);
    expect(await digestOf(pool, await company(), inv.id)).toBeNull();
    expect((await pool.query("SELECT approval_document_digest($1,'supplier_invoice',$2) AS d", [c, inv.id])).rows[0].d).toBeNull();
    await pool.query('UPDATE customer_invoices SET deleted_at = now() WHERE id = $1', [inv.id]);
    expect(await digestOf(pool, c, inv.id)).toBeNull();
  });

  it('moves with every hashed header column', async () => {
    const c = await company();
    await enableFxDocuments(pool, c); // FX PR0: `currency_code` is one of the columns
    const inv = await plantInvoice(pool, c, user);
    const base = await digestOf(pool, c, inv.id);
    const otherCustomer = (await plantInvoice(pool, c, user)).customerId;
    // customer_invoices.project_id carries no foreign key.
    const project = crypto.randomUUID();
    const moves: [string, unknown][] = [
      ['customer_id', otherCustomer], ['client_id', otherCustomer], ['invoice_number', 'CI-MOVED'],
      ['invoice_date', '2026-09-02'], ['currency_code', 'USD'], ['exchange_rate', 18.5],
      ['subtotal', 1001], ['tax_rate', 14], ['tax_amount', 151], ['total_amount', 1151],
      ['functional_total', 21275], ['project_id', project],
    ];
    for (const [column, value] of moves) {
      expect(await digestWith(c, 'customer_invoices', 'id', inv.id, inv.id, column, value), column).not.toBe(base);
    }
    expect(await digestOf(pool, c, inv.id)).toBe(base);
  });

  it('moves with every hashed line column, and with a line added or removed', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, user);
    const base = await digestOf(pool, c, inv.id);
    const line = await firstLine(inv.id);
    const account = (await pool.query(
      "SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = 'default_revenue'", [c])).rows[0].id;
    const moves: [string, unknown][] = [
      ['description', 'Line A edited'], ['quantity', 3], ['unit_price', 301], ['amount', 601],
      ['tax_rate', 0], ['gl_account_id', account], ['currency_code', 'USD'],
    ];
    for (const [column, value] of moves) {
      expect(await digestWith(c, 'customer_invoice_items', 'id', line, inv.id, column, value), column).not.toBe(base);
    }
    await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,unit_price,amount) VALUES($1,'Extra',1,1)", [inv.id]);
    const added = await digestOf(pool, c, inv.id);
    expect(added).not.toBe(base);
    await pool.query("DELETE FROM customer_invoice_items WHERE invoice_id = $1 AND description = 'Extra'", [inv.id]);
    expect(await digestOf(pool, c, inv.id)).toBe(base);
  });

  it('does not move with what an approval does not cover', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, user);
    const base = await digestOf(pool, c, inv.id);
    const still: [string, unknown][] = [
      ['status', 'cancelled'], ['notes', 'changed'], ['internal_notes', 'changed'], ['due_date', '2026-12-31'],
      ['billing_period_start', '2026-08-01'], ['billing_period_end', '2026-08-31'], ['amount_paid', 10],
      ['sent_at', '2026-09-03T00:00:00Z'], ['paid_at', '2026-09-03T00:00:00Z'], ['approved_by', other],
      ['approved_at', '2026-09-03T00:00:00Z'], ['email_sent_at', '2026-09-03T00:00:00Z'], ['email_sent_to', 'x@y.z'],
      ['email_message_id', 'm-1'], ['payment_url', 'https://pay'], ['online_payment_enabled', true],
      ['portal_token', 'tok-r035'], ['portal_viewed_at', '2026-09-03T00:00:00Z'], ['portal_paid_at', '2026-09-03T00:00:00Z'],
      ['rendered_pdf_storage_path', 'p'], ['rendered_pdf_sha256', 'h'], ['rendered_pdf_rendered_at', '2026-09-03T00:00:00Z'],
      ['external_ref', 'EXT-1'], ['external_document_number', 'EXT-DOC'], ['external_system', 'sage'],
      ['actor_type', 'agent'], ['actor_token_jti', 'jti-1'], ['created_by', other],
      ['created_at', '2026-01-01T00:00:00Z'], ['updated_at', '2026-01-01T00:00:00Z'],
      ['content_authors', [other]], ['content_edited_at', '2026-09-03T00:00:00Z'],
    ];
    for (const [column, value] of still) {
      expect(await digestWith(c, 'customer_invoices', 'id', inv.id, inv.id, column, value), column).toBe(base);
    }
    const timeEntry = (await pool.query(
      `INSERT INTO time_entries(company_id,user_id,task_description,entry_date,hours)
       VALUES($1,$2,'r035',DATE '2026-09-01',1) RETURNING id`,
      [c, user])).rows[0].id;
    expect(await digestWith(c, 'customer_invoice_items', 'id', await firstLine(inv.id), inv.id, 'time_entry_id', timeEntry))
      .toBe(base);
  });

  it('deleting the lines and re-inserting identical ones keeps the digest (Q9)', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, user);
    const base = await digestOf(pool, c, inv.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM customer_invoice_items WHERE invoice_id = $1', [inv.id]);
      // Inserted in the other order, with new ids and a new created_at.
      await client.query(
        `INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate,currency_code)
         VALUES($1,'Line B',1,400,400,15,'ZAR'),($1,'Line A',2.00,300.00,600,15.00,'ZAR')`, [inv.id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await digestOf(pool, c, inv.id)).toBe(base);
  });
});

describe('the customer invoice authors', () => {
  it('are the creator (a uuid created_by) plus every stamped editor; a non-uuid creator adds nobody', async () => {
    const c = await company();
    const inv = await plantInvoice(pool, c, user);
    await pool.query('UPDATE customer_invoices SET content_authors = ARRAY[$2::UUID] WHERE id = $1', [inv.id, other]);
    const authors = async () => (await pool.query(
      "SELECT approval_document_authors($1,'customer_invoice',$2)::TEXT[] AS a", [c, inv.id])).rows[0].a as string[] | null;
    expect((await authors())?.sort()).toEqual([user, other].sort());
    await pool.query("UPDATE customer_invoices SET created_by = 'system' WHERE id = $1", [inv.id]);
    expect(await authors()).toEqual([other]);
    await pool.query('UPDATE customer_invoices SET created_by = upper($2) WHERE id = $1', [inv.id, user]);
    expect((await authors())?.sort()).toEqual([user, other].sort());
  });
});

describe('the earlier branches are unchanged', () => {
  const MIGRATIONS = path.resolve(__dirname, '../../scripts/migrations/sql');
  /** The function as migration 862 defined it, re-created under a temporary name. */
  function asDefinedIn862(fn: string, alias: string): string {
    const text = readFileSync(path.join(MIGRATIONS, '862_credit_note_approval_enforcement.sql'), 'utf8');
    const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    const end = text.indexOf('$$;', start) + 3;
    expect(start, fn).toBeGreaterThan(-1);
    return text.slice(start, end).replace(`public.${fn}(`, `pg_temp.${alias}(`);
  }

  it('a bill and both kinds of credit note digest and list their authors exactly as 862 defined them', async () => {
    const c = await company();
    const bill = await plantBill(pool, c, user);
    const customerNote = await plantNote(pool, c, user, 'customer');
    const supplierNote = await plantNote(pool, c, user, 'supplier');
    await pool.query('UPDATE supplier_invoices SET content_authors = ARRAY[$2::UUID] WHERE id = $1', [bill.id, other]);
    await pool.query('UPDATE credit_notes SET content_authors = ARRAY[$2::UUID] WHERE company_id = $1', [c, other]);
    const client = await pool.connect();
    try {
      await client.query(asDefinedIn862('approval_document_digest', 'r035_digest_862'));
      await client.query(asDefinedIn862('approval_document_authors', 'r035_authors_862'));
      for (const [type, id] of [['supplier_invoice', bill.id], ['customer_credit_note', customerNote.id],
        ['supplier_credit_note', supplierNote.id]] as const) {
        const { rows: [r] } = await client.query(
          `SELECT pg_temp.r035_digest_862($1,$2,$3) AS old_digest, approval_document_digest($1,$2,$3) AS new_digest,
                  pg_temp.r035_authors_862($1,$2,$3)::TEXT AS old_authors, approval_document_authors($1,$2,$3)::TEXT AS new_authors`,
          [c, type, id]);
        expect(r.old_digest, type).toMatch(/^[0-9a-f]{64}$/);
        expect(r.new_digest, type).toBe(r.old_digest);
        expect(r.new_authors, type).toBe(r.old_authors);
        expect(r.new_authors, type).toContain(other);
      }
    } finally {
      client.release();
    }
  });
});
