/**
 * externalRefService against a real schema (brief step 3): the per-kind queries name real
 * columns, "live" means what the tools assume, every read and stamp is company-scoped, and the
 * advisory lock statement runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import {
  EXTERNAL_REF_KINDS, findByExternalRef, lockExternalRef, stampExternalRef,
} from '@/modules/accounting/services/core/externalRefService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const A = randomUUID();
const B = randomUUID();
const USER = randomUUID();
const TAG = `XREF-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let supplier: string;
let customer: string;
let bill: string;
let deletedBill: string;
let supplierNote: string;
let customerNote: string;
let journal: string;

const one = async (q: Promise<unknown>): Promise<string> => ((await q) as { id: string }[])[0]!.id;

describeIfDb('externalRefService', () => {
  beforeAll(async () => {
    for (const id of [A, B]) {
      await sql`INSERT INTO companies (id, name, registration_number, created_at) VALUES (${id}::UUID, ${`${TAG} ${id.slice(0, 4)}`}, ${`${TAG}-${id.slice(0, 4)}`}, NOW())`;
    }
    supplier = await one(sql`INSERT INTO suppliers (company_id, name) VALUES (${A}::UUID, ${`${TAG} supp`}) RETURNING id`);
    customer = await one(sql`INSERT INTO customers (company_id, name) VALUES (${A}::UUID, ${`${TAG} cust`}) RETURNING id`);
    bill = await one(sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, status, total_amount, created_by)
      VALUES (${A}::UUID, ${supplier}::UUID, ${`${TAG}-1`}, '2026-11-01', 'draft', 115, ${USER}::UUID) RETURNING id`);
    deletedBill = await one(sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, status, total_amount, created_by, deleted_at)
      VALUES (${A}::UUID, ${supplier}::UUID, ${`${TAG}-2`}, '2026-10-01', 'draft', 50, ${USER}::UUID, NOW()) RETURNING id`);
    supplierNote = await one(sql`
      INSERT INTO credit_notes (company_id, type, supplier_id, credit_date, subtotal, tax_rate, tax_amount, total_amount, status, created_by)
      VALUES (${A}::UUID, 'supplier', ${supplier}::UUID, '2026-11-02', 100, 15, 15, 115, 'draft', ${USER}) RETURNING id`);
    customerNote = await one(sql`
      INSERT INTO credit_notes (company_id, type, client_id, credit_date, subtotal, tax_rate, tax_amount, total_amount, status, created_by)
      VALUES (${A}::UUID, 'customer', ${customer}::UUID, '2026-11-02', 100, 15, 15, 115, 'draft', ${USER}) RETURNING id`);
    journal = await one(sql`
      INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
      VALUES (${A}::UUID, '2026-11-03', ${`${TAG} je`}, 'draft', ${USER}) RETURNING id`);
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM gl_journal_entries WHERE company_id IN (${A}::UUID, ${B}::UUID)`;
    await sql`DELETE FROM credit_notes WHERE company_id IN (${A}::UUID, ${B}::UUID)`;
    await sql`DELETE FROM supplier_invoices WHERE company_id IN (${A}::UUID, ${B}::UUID)`;
    await sql`DELETE FROM customers WHERE company_id IN (${A}::UUID, ${B}::UUID)`;
    await sql`DELETE FROM suppliers WHERE company_id IN (${A}::UUID, ${B}::UUID)`;
    await sql`DELETE FROM companies WHERE id IN (${A}::UUID, ${B}::UUID)`;
  }, 60000);

  it('every kind\'s lookup runs against the real columns', async () => {
    for (const kind of EXTERNAL_REF_KINDS) {
      await expect(findByExternalRef(A, kind, 'sage', `${TAG}-none`)).resolves.toEqual([]);
    }
  });

  it('stamps a bill and finds it as the live match; a soft-deleted one with the same ref is not live', async () => {
    await stampExternalRef(A, 'supplier_invoice', bill, { system: 'sage', ref: `${TAG}-SIV`, documentNumber: 'SIV0001' });
    await stampExternalRef(A, 'supplier_invoice', deletedBill, { system: 'sage', ref: `${TAG}-SIV` });
    const found = await findByExternalRef(A, 'supplier_invoice', 'sage', `${TAG}-SIV`);
    expect(found.map((m) => [m.id, m.live])).toEqual([[bill, true], [deletedBill, false]]);
    expect(found[0]).toMatchObject({ number: `${TAG}-1`, status: 'draft', date: '2026-11-01', totalAmount: 115, externalDocumentNumber: 'SIV0001' });
  });

  it('finds a reference whatever case its system was stored in', async () => {
    await sql`UPDATE supplier_invoices SET external_system = 'Sage' WHERE id = ${bill}::UUID`;
    expect((await findByExternalRef(A, 'supplier_invoice', 'sage', `${TAG}-SIV`))[0]?.id).toBe(bill);
    await sql`UPDATE supplier_invoices SET external_system = 'sage' WHERE id = ${bill}::UUID`;
  });

  it('is company-scoped both ways: another company neither sees nor stamps the row', async () => {
    await expect(findByExternalRef(B, 'supplier_invoice', 'sage', `${TAG}-SIV`)).resolves.toEqual([]);
    await expect(stampExternalRef(B, 'supplier_invoice', bill, { system: 'sage', ref: `${TAG}-X` }))
      .rejects.toThrow(/not a row of this company/);
    const [row] = (await sql`SELECT external_ref FROM supplier_invoices WHERE id = ${bill}::UUID`) as { external_ref: string }[];
    expect(row!.external_ref).toBe(`${TAG}-SIV`);
  });

  it('narrows credit notes to one side, and a cancelled note is not live', async () => {
    await stampExternalRef(A, 'credit_note', supplierNote, { system: 'sage', ref: `${TAG}-RTN` });
    await stampExternalRef(A, 'credit_note', customerNote, { system: 'sage', ref: `${TAG}-RTN` });
    expect((await findByExternalRef(A, 'credit_note', 'sage', `${TAG}-RTN`, { creditNoteType: 'supplier' })).map((m) => m.id)).toEqual([supplierNote]);
    await sql`UPDATE credit_notes SET status = 'cancelled' WHERE id = ${customerNote}::UUID`;
    const cust = await findByExternalRef(A, 'credit_note', 'sage', `${TAG}-RTN`, { creditNoteType: 'customer' });
    expect(cust).toMatchObject([{ id: customerNote, live: false, creditNoteType: 'customer' }]);
  });

  it('a bank line the feed removed is not live', async () => {
    const acct = (await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
      VALUES (${A}::UUID, ${`${TAG.slice(-6)}B`}, ${`${TAG} bank`}, 'asset', 'bank', 'debit', true) RETURNING id`) as { id: string }[];
    const [feed] = (await sql`
      INSERT INTO bank_feed_connections (company_id, bank_account_id, provider, status)
      VALUES (${A}::UUID, ${acct[0]!.id}::UUID, 'extension', 'active') RETURNING id`) as { id: string }[];
    const [line] = (await sql`
      INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, external_system, external_ref,
                                     feed_state, bank_feed_connection_id, provider_transaction_id)
      VALUES (${A}::UUID, ${acct[0]!.id}::UUID, '2026-11-04', -50, ${TAG}, 'sage', ${`${TAG}-BANK`},
              'removed', ${feed!.id}::UUID, ${`${TAG}-PTX`}) RETURNING id`) as { id: string }[];
    expect((await findByExternalRef(A, 'bank_transaction', 'sage', `${TAG}-BANK`))).toMatchObject([{ id: line!.id, live: false }]);
    await sql`DELETE FROM bank_transactions WHERE id = ${line!.id}::UUID`;
    await sql`DELETE FROM bank_feed_connections WHERE id = ${feed!.id}::UUID`;
    await sql`DELETE FROM gl_accounts WHERE id = ${acct[0]!.id}::UUID`;
  });

  it('a reversed journal is not live', async () => {
    await stampExternalRef(A, 'journal', journal, { system: 'sage', ref: `${TAG}-JE` });
    expect((await findByExternalRef(A, 'journal', 'sage', `${TAG}-JE`))[0]).toMatchObject({ id: journal, live: true });
    await sql`UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = ${journal}::UUID`;
    expect((await findByExternalRef(A, 'journal', 'sage', `${TAG}-JE`))[0]).toMatchObject({ id: journal, live: false });
  });

  it('the lock is held for the transaction: a second connection cannot take the same reference', async () => {
    const { als } = await import('@/lib/als');
    const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });
    const holder = await pool.connect();
    const other = await pool.connect();
    try {
      await holder.query('BEGIN');
      await als.run({ client: holder, userId: USER, companyId: A, claims: {} } as never, async () => {
        await lockExternalRef(A, 'supplier_invoice', 'sage', `${TAG}-LOCK`);
      });
      const key = `external_ref:${A}:supplier_invoice:sage:${TAG}-LOCK`;
      const blocked = await other.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got', [key]);
      expect(blocked.rows[0].got).toBe(false);
      const otherRef = await other.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got', [`${key}-other`]);
      expect(otherRef.rows[0].got).toBe(true);
      await holder.query('ROLLBACK');
      const freed = await other.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got', [key]);
      expect(freed.rows[0].got).toBe(true);
    } finally {
      holder.release();
      other.release();
      await pool.end();
    }
  });
});
