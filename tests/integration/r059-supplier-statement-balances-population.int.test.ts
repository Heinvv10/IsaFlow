/**
 * R-059 round 6 (MEDIUM-2) — supplier statement balances do not deduct a
 * payment twice when the bill it settles has a NULL status.
 *
 * getSupplierStatementBalances takes the invoice side from apAgingService and
 * adds "on-account funds": payments and credit notes NOT already absorbed by a
 * bill in the ageing's population. Its two absorption legs said "Same
 * population as apAgingService" but used the bare status NOT IN, which is NULL
 * for a null-status bill. So a payment allocated to one was netted off the bill
 * by the ageing AND reported as unapplied funds: deducted twice.
 *
 * Fixture: one supplier, bill B 1000 with status NULL and amount_paid 400, and
 * a processed payment of 400 allocated to it. Ageing 600; on-account 0; net
 * 600. Round 5 gave on-account 400 and net 200. A control bill with a real
 * status gives the same 600 / 0 / 600, which is the point: the status of a bill
 * the ageing counts must not change what the statement says is owed.
 *
 * The CREDIT-NOTE leg has the same shape and needed its own row to be pinned
 * (mutating it alone stayed green otherwise): bill 1000 with status NULL, and a
 * supplier credit note of 100 applied to it — amount_paid 100. Ageing 900; the
 * note is absorbed, so on-account 0 and net 900. The bare spelling reports the
 * note's 100 as on-account funds too: net 800.
 *
 * Why this file and not supplierStatementBalances.int.test.ts: that file is red
 * on master too (R-076 — its shadow tables lack deleted_at), so a pass or fail
 * there says nothing about this change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getSupplierStatementBalances } from '@/modules/accounting/services/ap/supplierStatementBalancesService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const TAG = `R59B${Math.floor(Math.random() * 1e8)}`;

function shift(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
const TODAY = fmtDate(new Date());

/** One supplier per case, so each row of the result is one case. */
const suppliers: Record<'nullStatus' | 'approved' | 'nullCredited', string> = {
  nullStatus: '', approved: '', nullCredited: '',
};

describeIfDb('R-059 supplier statement balances: a null-status bill absorbs its payment', () => {
  beforeAll(async () => {
    assertDisposable();
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'R059B ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    for (const [key, status] of [['nullStatus', null], ['approved', 'approved']] as const) {
      const supplier = ((await sql`
        INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${key + ' ' + TAG}) RETURNING id
      `) as { id: string }[])[0]!.id;
      suppliers[key] = supplier;
      const bill = ((await sql`
        INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
          status, subtotal, tax_amount, total_amount, amount_paid, created_by)
        VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-' + key.slice(0, 4)}, ${shift(-60)}::date,
          ${shift(-30)}::date, ${status}, 1000, 0, 1000, 400, ${USER}::UUID)
        RETURNING id`) as { id: string }[])[0]!.id;
      const pay = ((await sql`
        INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status, created_by)
        VALUES (${COMPANY}::UUID, ${TAG + '-P' + key.slice(0, 4)}, ${supplier}::UUID, ${shift(-20)}::date,
          400, 'processed', ${USER}::UUID)
        RETURNING id`) as { id: string }[])[0]!.id;
      await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
                VALUES (${pay}::UUID, ${bill}::UUID, 400)`;
    }

    // The credit-note case: no payment, one applied note of 100.
    const supplier = ((await sql`
      INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'nullCredited ' + TAG}) RETURNING id
    `) as { id: string }[])[0]!.id;
    suppliers.nullCredited = supplier;
    const bill = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${COMPANY}::UUID, ${supplier}::UUID, ${TAG + '-cred'}, ${shift(-60)}::date,
        ${shift(-30)}::date, NULL, 1000, 0, 1000, 100, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`
      INSERT INTO credit_notes (company_id, type, supplier_id, supplier_invoice_id, credit_note_number,
        credit_date, subtotal, tax_amount, total_amount, status, created_by, applied_amount)
      VALUES (${COMPANY}::UUID, 'supplier', ${supplier}::UUID, ${bill}::UUID, ${TAG + '-CN'},
        ${shift(-20)}::date, 100, 0, 100, 'applied', ${USER}::UUID, 100)`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
  }, 120000);

  it('the premise: exactly two bills carry a NULL status', async () => {
    const [r] = (await sql`
      SELECT COUNT(*)::INT AS n FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID AND status IS NULL
    `) as { n: number }[];
    expect(r!.n).toBe(2);
  });

  const CASES = [
    { key: 'nullStatus' as const, what: 'the payment is deducted once', open: 600 },
    { key: 'approved' as const, what: 'the control with a real status', open: 600 },
    { key: 'nullCredited' as const, what: 'the credit note is deducted once', open: 900 },
  ];
  for (const c of CASES) {
    it(`${c.key}: ageing ${c.open}, on-account 0, net ${c.open} — ${c.what}`, async () => {
      const rows = await getSupplierStatementBalances(COMPANY, TODAY);
      const row = rows.find(r => r.entityId === suppliers[c.key]);
      expect(row).toBeDefined();
      expect({ total: row!.total, onAccount: row!.onAccount, net: row!.netBalance })
        .toEqual({ total: c.open, onAccount: 0, net: c.open });
    });
  }
});
