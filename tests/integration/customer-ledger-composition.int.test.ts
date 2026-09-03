// tests/integration/customer-ledger-composition.int.test.ts
//
// The customer ledger is a STATEMENT — it is emailed to the customer and it is
// what they are asked to pay. Two defects made it overstate the debt:
//
//   DRAFTS AND CANCELLED INVOICES WERE DEBITED. The invoice leg filtered only
//   on deleted_at, with no status filter at all, so a draft invoice — one that
//   has not been issued to anyone — appeared on the customer's statement as
//   money owed, as did cancelled ones. Production: 130 drafts worth
//   R5,555,315.66 and 58 cancelled worth R48,050.63.
//
//   CREDIT NOTES WERE ABSENT. The ledger is a UNION of invoices and receipts.
//   Approving a credit note raises customer_invoices.amount_paid, but the
//   ledger debits the GROSS total_amount and takes credits only from
//   customer_payments — so the credit appeared nowhere and reduced nothing.
//   Production: 93 applied notes worth R372,634.32.
//
// Together the statement asked customers for up to R5,976,000.61 they did not
// owe. These tests assert the running balance, which is the number the
// customer reads.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getCustomerLedger } from '@/modules/accounting/services/ar/customerLedgerService';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-0000000000c1';
const CUSTOMER = '00000000-0000-0000-0000-0000000000c2';
const BANK = '00000000-0000-0000-0000-0000000000c3';

const APPROVED_INVOICE = 10000;
const DRAFT_INVOICE = 4000;
const CANCELLED_INVOICE = 1500;
const RECEIPT = 2500;
const CREDIT_NOTE = 1000;

// What the customer actually owes: the issued invoice, less what they paid,
// less the credit note they were granted.
const TRUE_BALANCE = APPROVED_INVOICE - RECEIPT - CREDIT_NOTE; // 6500

const describeIfDb = DATABASE_URL ? describe : describe.skip;

describeIfDb('customer ledger shows what the customer actually owes', () => {
  let admin: Pool;

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes ledger fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'Ledger Fixture', true)
       ON CONFLICT (id) DO NOTHING`,
      [COMPANY],
    );
    await admin.query(
      `INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Ledger Customer')
       ON CONFLICT (id) DO NOTHING`,
      [CUSTOMER, COMPANY],
    );
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1, $2, 'CL1000', 'Bank', 'asset', 'bank', 'debit', true)
       ON CONFLICT (id) DO NOTHING`,
      [BANK, COMPANY],
    );

    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
       VALUES
         ($1,$2,$2,'CL-1','2026-02-01','2026-03-01','approved',  $3, 0, $6),
         ($1,$2,$2,'CL-2','2026-02-05','2026-03-05','draft',     $4, 0, $6),
         ($1,$2,$2,'CL-3','2026-02-06','2026-03-06','cancelled', $5, 0, $6)`,
      [COMPANY, CUSTOMER, APPROVED_INVOICE, DRAFT_INVOICE, CANCELLED_INVOICE, COMPANY],
    );

    await admin.query(
      `INSERT INTO customer_payments
         (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
       VALUES ($1,$2,'CL-R1','2026-03-10',$3,'confirmed',$4,$5)`,
      [COMPANY, CUSTOMER, RECEIPT, BANK, COMPANY],
    );

    await admin.query(
      `INSERT INTO credit_notes
         (company_id, client_id, credit_note_number, credit_date, type, status, total_amount, created_by)
       VALUES ($1,$2,'CL-CN1','2026-03-15','customer','applied',$3,$4)`,
      [COMPANY, CUSTOMER, CREDIT_NOTE, COMPANY],
    );
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('closes at what the customer owes', async () => {
    const ledger = (await getCustomerLedger(COMPANY, CUSTOMER, {}))!;
    expect(ledger.closingBalance).toBeCloseTo(TRUE_BALANCE, 2);
  });

  it('leaves a draft invoice off the statement', async () => {
    const ledger = (await getCustomerLedger(COMPANY, CUSTOMER, {}))!;
    // A draft has been issued to nobody. Billing for it is the worst kind of
    // error on a document that goes to the customer.
    expect(ledger.transactions.some((t) => t.reference === 'CL-2')).toBe(false);
  });

  it('leaves a cancelled invoice off the statement', async () => {
    const ledger = (await getCustomerLedger(COMPANY, CUSTOMER, {}))!;
    expect(ledger.transactions.some((t) => t.reference === 'CL-3')).toBe(false);
  });

  it('credits the customer for a credit note', async () => {
    const ledger = (await getCustomerLedger(COMPANY, CUSTOMER, {}))!;
    const note = ledger.transactions.find((t) => t.reference === 'CL-CN1');

    expect(note).toBeDefined();
    expect(note?.type).toBe('credit_note');
    expect(note?.credit).toBeCloseTo(CREDIT_NOTE, 2);
    expect(note?.debit).toBeCloseTo(0, 2);
  });

  it('the running balance is the ledger walked in date order', async () => {
    const ledger = (await getCustomerLedger(COMPANY, CUSTOMER, {}))!;

    let running = 0;
    for (const t of ledger.transactions) {
      running += t.debit - t.credit;
      expect(t.balance).toBeCloseTo(running, 2);
    }
    expect(ledger.closingBalance).toBeCloseTo(running, 2);
  });

  it('excludes a cancelled credit note', async () => {
    await admin.query(
      `INSERT INTO credit_notes
         (company_id, client_id, credit_note_number, credit_date, type, status, total_amount, created_by)
       VALUES ($1,$2,'CL-CN2','2026-03-16','customer','cancelled',9999,$3)`,
      [COMPANY, CUSTOMER, COMPANY],
    );
    try {
      const ledger = (await getCustomerLedger(COMPANY, CUSTOMER, {}))!;
      expect(ledger.transactions.some((t) => t.reference === 'CL-CN2')).toBe(false);
      expect(ledger.closingBalance).toBeCloseTo(TRUE_BALANCE, 2);
    } finally {
      await admin.query(`DELETE FROM credit_notes WHERE credit_note_number = 'CL-CN2'`);
    }
  });
});

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM credit_notes WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customer_payments WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customer_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
