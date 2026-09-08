/**
 * The race-detection regexes, asserted against what the SERVICES actually throw.
 *
 * Blind review, 2026-09-08 (LOW). Two of the three bulk approve arms decide
 * "this element lost a race, skip it" by matching a regex against an `Error`
 * message owned by a different module:
 *
 *   approveSupplierInvoice → `Cannot approve invoice with status: <status>`
 *   approveCreditNote      → `Cannot approve credit note with status: <status>`
 *
 * Both services throw a bare `Error`, so there is no class to match on. The unit
 * tests hardcode the same literals the tools' regexes expect, which restates the
 * assumption instead of testing it: if a service reworded its refusal tomorrow,
 * every unit test would still pass and the tools would silently stop
 * recognising the race.
 *
 * The failure that causes is not corruption — an unrecognised refusal falls
 * through to `BulkAllocationLineError` and the batch rolls back — but it turns
 * a routine skipped line into a failed 100-element batch, which is exactly the
 * outcome these tools exist to avoid.
 *
 * So this test calls the REAL services against a genuinely non-approvable row
 * and asserts `racedReason` recognises the message they actually produce. A
 * wording change breaks this test at the point of drift.
 *
 * The customer-invoice arm is deliberately absent: it matches
 * `InvoiceNotApprovableError` by `instanceof`, so it cannot drift this way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { racedReason as supplierRacedReason } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import { racedReason as creditNoteRacedReason } from '@/lib/mcp/tools/writeBulkApproveCreditNotes';

const COMPANY = '00000000-0000-0000-0000-000000000ab4';
const USER = '00000000-0000-0000-e2e0-000000000001';
const TAG = `DRIFT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

let pool: Pool;
let supplier: string;
let customer: string;

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  const c: PoolClient = await pool.connect();
  await c.query('BEGIN');
  try {
    const out = await als.run(
      { client: c, userId: USER, companyId: COMPANY, claims: {} } as never, fn,
    );
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${COMPANY}::UUID, 'Drift Test', 'DRIFT-TEST', NOW())
    ON CONFLICT (id) DO NOTHING`;
  supplier = (await sql`
    INSERT INTO suppliers (name, company_id) VALUES (${'DRIFT ' + TAG}, ${COMPANY}::UUID)
    RETURNING id` as { id: string }[])[0]!.id;
  customer = (await sql`
    INSERT INTO customers (name, company_id) VALUES (${'DRIFT ' + TAG}, ${COMPANY}::UUID)
    RETURNING id` as { id: string }[])[0]!.id;
});

afterAll(async () => {
  await sql`DELETE FROM credit_notes WHERE client_id = ${customer}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE supplier_id = ${supplier}::UUID`;
  await sql`DELETE FROM suppliers WHERE id = ${supplier}::UUID`;
  await sql`DELETE FROM customers WHERE id = ${customer}::UUID`;
  await pool.end();
});

describe('racedReason recognises what the real services throw', () => {
  /**
   * `cancelled` rather than `approved`: it proves the STATUS is captured out of
   * the message and reported, not flattened to "already approved" — which would
   * tell an agent its cancelled bill had been posted.
   */
  it('supplier invoices — the status is captured from the live message', async () => {
    const id = (await sql`
      INSERT INTO supplier_invoices
        (company_id, supplier_id, invoice_number, invoice_date, subtotal,
         tax_rate, tax_amount, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-SI'}, '2026-06-30',
              100, 15, 15, 115, 'cancelled', ${USER}::UUID)
      RETURNING id` as { id: string }[])[0]!.id;

    const err = await inTx(() => approveSupplierInvoice(COMPANY, id, USER))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const reason = supplierRacedReason(err);
    expect(reason, `racedReason did not recognise: ${(err as Error).message}`).not.toBeNull();
    expect(reason).toContain('cancelled');
  });

  it('credit notes — the status is captured from the live message', async () => {
    const id = (await sql`
      INSERT INTO credit_notes
        (company_id, type, client_id, credit_date, subtotal, tax_rate,
         tax_amount, total_amount, status, created_by)
      VALUES (${COMPANY}::UUID, 'customer', ${customer}::UUID, '2026-06-30',
              100, 15, 15, 115, 'cancelled', ${USER}::UUID)
      RETURNING id` as { id: string }[])[0]!.id;

    const err = await inTx(() => approveCreditNote(COMPANY, id, USER))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const reason = creditNoteRacedReason(err);
    expect(reason, `racedReason did not recognise: ${(err as Error).message}`).not.toBeNull();
    expect(reason).toContain('cancelled');
  });

  /**
   * The other half of the contract: a genuine fault must NOT be mistaken for a
   * race and skipped. A skip that swallowed a real failure would report the
   * batch as partially fine while the element silently never posted.
   */
  it('does not mistake an unrelated failure for a race', () => {
    const unrelated = new Error('VAT Input system account not found');
    expect(supplierRacedReason(unrelated)).toBeNull();
    expect(creditNoteRacedReason(unrelated)).toBeNull();
  });

  /** Nor a message that merely contains the word, from another document type. */
  it('does not cross-match the other document type\'s refusal', () => {
    const creditNoteMessage = new Error('Cannot approve credit note with status: approved');
    expect(supplierRacedReason(creditNoteMessage)).toBeNull();
  });
});
