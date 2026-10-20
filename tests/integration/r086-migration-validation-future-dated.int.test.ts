/**
 * Integration test: R-086 review rounds 3 and 4 — the AR/AP-vs-GL checks are a
 * CURRENT-state reconciliation. A future-dated journal, a reversal dated before
 * the entry it reverses, and an amount_paid above the total must all leave the
 * document half agreeing with the GL half. Real DB (fixture.env), no mocks.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { Pool } from 'pg';
import { restoreAmountPaidCheck, suspendAmountPaidCheck } from './helpers/amountPaidCheck';
import { insertPreConstraintRow } from './helpers/preConstraintRow';
import { sql } from '@/lib/neon';
import { validateMigration } from '@/modules/accounting/services/core/migrationValidationService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import {
  USER_ID, FUTURE_DATE_EXPR, createGlAccount, postJournal, postJournalDated, setupCompanies, teardownCompanies,
} from './r086-migration-validation.helpers';

const COMPANY_AR_FUTURE_LIVE = '00000000-0000-0000-0086-0000000000a7';
const COMPANY_AP_FUTURE_LIVE = '00000000-0000-0000-0086-0000000000a8';
const COMPANY_AR_FUTURE_DEL = '00000000-0000-0000-0086-0000000000a9';
const COMPANY_AP_FUTURE_DEL = '00000000-0000-0000-0086-0000000000aa';
const COMPANY_AR_ORDER = '00000000-0000-0000-0086-0000000000ab';
const COMPANY_AP_ORDER = '00000000-0000-0000-0086-0000000000ac';
const COMPANY_AR_PAID = '00000000-0000-0000-0086-0000000000ad';
const COMPANY_AR_NEG = '00000000-0000-0000-0086-0000000000ae';
const COMPANIES: Array<[string, string]> = [
  [COMPANY_AR_NEG, 'R086 Test Company AR Negative Total'],
  ['00000000-0000-0000-0086-0000000000a7', 'R086 Test Company AR Future Live'],
  ['00000000-0000-0000-0086-0000000000a8', 'R086 Test Company AP Future Live'],
  ['00000000-0000-0000-0086-0000000000a9', 'R086 Test Company AR Future Deleted'],
  ['00000000-0000-0000-0086-0000000000aa', 'R086 Test Company AP Future Deleted'],
  ['00000000-0000-0000-0086-0000000000ab', 'R086 Test Company AR Out-Of-Order Chain'],
  ['00000000-0000-0000-0086-0000000000ac', 'R086 Test Company AP Out-Of-Order Chain'],
  ['00000000-0000-0000-0086-0000000000ad', 'R086 Test Company AR Overpaid'],
];

// 899's CHECK refuses the over-paid invoice the round-4 case plants on purpose.
beforeAll(async () => { await suspendAmountPaidCheck(); await setupCompanies(COMPANIES); });
afterAll(async () => { await teardownCompanies(COMPANIES); await restoreAmountPaidCheck(); });

describe('R-086 review round 3, MEDIUM: a future-dated posted journal must not desync the GL half from the document half', () => {
  it('AR vs GL passes for a LIVE "sent" invoice whose journal is dated in the future', async () => {
    const receivableId = await createGlAccount(COMPANY_AR_FUTURE_LIVE, 'R086FL-AR-1200', 'receivable', 'asset', 'debit');
    const revenueId = await createGlAccount(COMPANY_AR_FUTURE_LIVE, 'R086FL-AR-4000', 'default_revenue', 'revenue', 'credit');

    const [customer] = (await sql`
      INSERT INTO customers (name, company_id) VALUES ('R086FL Customer', ${COMPANY_AR_FUTURE_LIVE}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY_AR_FUTURE_LIVE}::UUID, 'R086FL-CI-1', ${customer.id}::UUID, ${customer.id}::UUID,
        ${sql.unsafe(FUTURE_DATE_EXPR)}, ${sql.unsafe(FUTURE_DATE_EXPR)} + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'sent', ${USER_ID}::UUID
      )
    `;

    await postJournalDated(COMPANY_AR_FUTURE_LIVE, receivableId, revenueId, 1150.00, 'R086FL-JE-AR-1', FUTURE_DATE_EXPR);

    const results = await validateMigration(COMPANY_AR_FUTURE_LIVE, 'r086-future-live-ar');
    const arCheck = results.find(r => r.check === 'AR vs GL');

    expect(arCheck).toBeDefined();
    expect(arCheck!.status).toBe('pass');
  });

  it('AP vs GL passes for a LIVE "disputed" invoice whose journal is dated in the future', async () => {
    const payableId = await createGlAccount(COMPANY_AP_FUTURE_LIVE, 'R086FL-AP-2100', 'payable', 'liability', 'credit');
    const expenseId = await createGlAccount(COMPANY_AP_FUTURE_LIVE, 'R086FL-AP-5000', 'default_expense', 'expense', 'debit');

    const [supplier] = (await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R086FL Supplier', ${COMPANY_AP_FUTURE_LIVE}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY_AP_FUTURE_LIVE}::UUID, 'R086FL-SI-1', ${supplier.id}::UUID,
        ${sql.unsafe(FUTURE_DATE_EXPR)}, ${sql.unsafe(FUTURE_DATE_EXPR)} + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'disputed', ${USER_ID}::UUID
      )
    `;

    await postJournalDated(COMPANY_AP_FUTURE_LIVE, expenseId, payableId, 1150.00, 'R086FL-JE-AP-1', FUTURE_DATE_EXPR);

    const results = await validateMigration(COMPANY_AP_FUTURE_LIVE, 'r086-future-live-ap');
    const apCheck = results.find(r => r.check === 'AP vs GL');

    expect(apCheck).toBeDefined();
    expect(apCheck!.status).toBe('pass');
  });

  it('AR vs GL passes after a future-dated "sent" invoice is soft-deleted', async () => {
    const receivableId = await createGlAccount(COMPANY_AR_FUTURE_DEL, 'R086FD-AR-1200', 'receivable', 'asset', 'debit');
    const revenueId = await createGlAccount(COMPANY_AR_FUTURE_DEL, 'R086FD-AR-4000', 'default_revenue', 'revenue', 'credit');

    const [customer] = (await sql`
      INSERT INTO customers (name, company_id) VALUES ('R086FD Customer', ${COMPANY_AR_FUTURE_DEL}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    const jeId = await postJournalDated(COMPANY_AR_FUTURE_DEL, receivableId, revenueId, 1150.00, 'R086FD-JE-AR-1', FUTURE_DATE_EXPR);

    const [invoice] = (await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, gl_journal_entry_id, created_by
      ) VALUES (
        ${COMPANY_AR_FUTURE_DEL}::UUID, 'R086FD-CI-1', ${customer.id}::UUID, ${customer.id}::UUID,
        ${sql.unsafe(FUTURE_DATE_EXPR)}, ${sql.unsafe(FUTURE_DATE_EXPR)} + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'sent', ${jeId}::UUID, ${USER_ID}::UUID
      ) RETURNING id
    `) as Array<{ id: string }>;

    // softDelete's reversal can date itself to TODAY when the future
    // original's fiscal period isn't open — dated BEFORE the entry it
    // reverses, the one case documentInLedgerAsAtFragment's chain-parity
    // math assumes never happens as-at a real date. The CURRENT_STATE_SENTINEL
    // fix sidesteps this: order stops mattering once every entry in the chain
    // is always "on or before" the sentinel.
    await softDelete(COMPANY_AR_FUTURE_DEL, 'customer_invoice', invoice.id, USER_ID);

    const results = await validateMigration(COMPANY_AR_FUTURE_DEL, 'r086-future-del-ar');
    const arCheck = results.find(r => r.check === 'AR vs GL');

    expect(arCheck).toBeDefined();
    expect(arCheck!.status).toBe('pass');
  });

  it('AP vs GL passes after a future-dated "disputed" invoice is soft-deleted', async () => {
    const payableId = await createGlAccount(COMPANY_AP_FUTURE_DEL, 'R086FD-AP-2100', 'payable', 'liability', 'credit');
    const expenseId = await createGlAccount(COMPANY_AP_FUTURE_DEL, 'R086FD-AP-5000', 'default_expense', 'expense', 'debit');

    const [supplier] = (await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R086FD Supplier', ${COMPANY_AP_FUTURE_DEL}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    const jeId = await postJournalDated(COMPANY_AP_FUTURE_DEL, expenseId, payableId, 1150.00, 'R086FD-JE-AP-1', FUTURE_DATE_EXPR);

    const [invoice] = (await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, gl_journal_entry_id, created_by
      ) VALUES (
        ${COMPANY_AP_FUTURE_DEL}::UUID, 'R086FD-SI-1', ${supplier.id}::UUID,
        ${sql.unsafe(FUTURE_DATE_EXPR)}, ${sql.unsafe(FUTURE_DATE_EXPR)} + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'disputed', ${jeId}::UUID, ${USER_ID}::UUID
      ) RETURNING id
    `) as Array<{ id: string }>;

    await softDelete(COMPANY_AP_FUTURE_DEL, 'supplier_invoice', invoice.id, USER_ID);

    const results = await validateMigration(COMPANY_AP_FUTURE_DEL, 'r086-future-del-ap');
    const apCheck = results.find(r => r.check === 'AP vs GL');

    expect(apCheck).toBeDefined();
    expect(apCheck!.status).toBe('pass');
  });
});

describe('R-086 review round 3, MEDIUM (deterministic): a hand-built out-of-order reversal chain', () => {
  // Through the real softDelete path the violation depends on whether the
  // future date's fiscal period is already open, so the chain is built in
  // SQL, as k053-out-of-order-reversal-chain.int.test.ts does.
  it('AR vs GL passes even when the reversal is dated before the entry it reverses', async () => {
    const receivableId = await createGlAccount(COMPANY_AR_ORDER, 'R086OO-AR-1200', 'receivable', 'asset', 'debit');
    const revenueId = await createGlAccount(COMPANY_AR_ORDER, 'R086OO-AR-4000', 'default_revenue', 'revenue', 'credit');

    const [customer] = (await sql`
      INSERT INTO customers (name, company_id) VALUES ('R086OO Customer', ${COMPANY_AR_ORDER}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    // The original, dated 90 days in the future.
    const originalId = await postJournalDated(COMPANY_AR_ORDER, receivableId, revenueId, 1150.00, 'R086OO-JE-AR-1', FUTURE_DATE_EXPR);

    const [invoice] = (await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, gl_journal_entry_id, created_by
      ) VALUES (
        ${COMPANY_AR_ORDER}::UUID, 'R086OO-CI-1', ${customer.id}::UUID, ${customer.id}::UUID,
        ${sql.unsafe(FUTURE_DATE_EXPR)}, ${sql.unsafe(FUTURE_DATE_EXPR)} + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'sent', ${originalId}::UUID, ${USER_ID}::UUID
      ) RETURNING id
    `) as Array<{ id: string }>;

    // Hand-built reversal dated TODAY — before the original it reverses.
    // resolveReversalDate's default path produces exactly this when the
    // future original's period is not open (R-012); built directly so the
    // proof does not depend on fiscal-period state, as
    // k053-out-of-order-reversal-chain.int.test.ts does for the predicate.
    const reversalId = (await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, reversal_of_id, created_by)
      VALUES (${COMPANY_AR_ORDER}::UUID, 'R086OO-JE-AR-REV', CURRENT_DATE, 'R086OO hand-built reversal', 'posted', 'manual', ${originalId}::UUID, ${USER_ID}::UUID)
      RETURNING id
    `) as Array<{ id: string }>;
    const reversalIdStr = reversalId[0]!.id;
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${COMPANY_AR_ORDER}::UUID, ${reversalIdStr}::UUID, ${receivableId}::UUID, 0, 1150.00),
             (${COMPANY_AR_ORDER}::UUID, ${reversalIdStr}::UUID, ${revenueId}::UUID, 1150.00, 0)
    `;
    await sql`UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = ${originalId}::UUID AND company_id = ${COMPANY_AR_ORDER}::UUID`;
    await sql`UPDATE customer_invoices SET deleted_at = NOW() WHERE id = ${invoice.id}::UUID AND company_id = ${COMPANY_AR_ORDER}::UUID`;

    const results = await validateMigration(COMPANY_AR_ORDER, 'r086-order-ar');
    const arCheck = results.find(r => r.check === 'AR vs GL');

    expect(arCheck).toBeDefined();
    expect(arCheck!.status).toBe('pass');
  });
  it('AP vs GL passes even when the reversal is dated before the entry it reverses', async () => {
    const payableId = await createGlAccount(COMPANY_AP_ORDER, 'R086OO-AP-2100', 'payable', 'liability', 'credit');
    const expenseId = await createGlAccount(COMPANY_AP_ORDER, 'R086OO-AP-5000', 'default_expense', 'expense', 'debit');
    const [supplier] = (await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R086OO Supplier', ${COMPANY_AP_ORDER}::UUID) RETURNING id
    `) as Array<{ id: string }>;
    const originalId = await postJournalDated(COMPANY_AP_ORDER, expenseId, payableId, 1150.00, 'R086OO-JE-AP-1', FUTURE_DATE_EXPR);
    const [bill] = (await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, gl_journal_entry_id, created_by
      ) VALUES (
        ${COMPANY_AP_ORDER}::UUID, 'R086OO-SI-1', ${supplier.id}::UUID,
        ${sql.unsafe(FUTURE_DATE_EXPR)}, ${sql.unsafe(FUTURE_DATE_EXPR)} + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'disputed', ${originalId}::UUID, ${USER_ID}::UUID
      ) RETURNING id
    `) as Array<{ id: string }>;
    const [reversal] = (await sql`
      INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, reversal_of_id, created_by)
      VALUES (${COMPANY_AP_ORDER}::UUID, 'R086OO-JE-AP-REV', CURRENT_DATE, 'R086OO hand-built reversal', 'posted', 'manual', ${originalId}::UUID, ${USER_ID}::UUID)
      RETURNING id
    `) as Array<{ id: string }>;
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${COMPANY_AP_ORDER}::UUID, ${reversal.id}::UUID, ${payableId}::UUID, 1150.00, 0),
             (${COMPANY_AP_ORDER}::UUID, ${reversal.id}::UUID, ${expenseId}::UUID, 0, 1150.00)
    `;
    await sql`UPDATE gl_journal_entries SET reversed_at = NOW() WHERE id = ${originalId}::UUID AND company_id = ${COMPANY_AP_ORDER}::UUID`;
    await sql`UPDATE supplier_invoices SET deleted_at = NOW() WHERE id = ${bill.id}::UUID AND company_id = ${COMPANY_AP_ORDER}::UUID`;

    const results = await validateMigration(COMPANY_AP_ORDER, 'r086-order-ap');
    expect(results.find(r => r.check === 'AP vs GL')?.status).toBe('pass');
  });
});

describe('R-086 review round 4, LOW: a paid document with amount_paid above its total contributes nothing, not a negative', () => {
  it('AR vs GL passes when the only invoice is paid with amount_paid > total_amount', async () => {
    const receivableId = await createGlAccount(COMPANY_AR_PAID, 'R086OP-AR-1200', 'receivable', 'asset', 'debit');
    const revenueId = await createGlAccount(COMPANY_AR_PAID, 'R086OP-AR-4000', 'default_revenue', 'revenue', 'credit');
    const bankId = await createGlAccount(COMPANY_AR_PAID, 'R086OP-AR-1000', 'bank', 'asset', 'debit');
    const [customer] = (await sql`
      INSERT INTO customers (name, company_id) VALUES ('R086OP Customer', ${COMPANY_AR_PAID}::UUID) RETURNING id
    `) as Array<{ id: string }>;
    const jeId = await postJournal(COMPANY_AR_PAID, receivableId, revenueId, 1150.00, 'R086OP-JE-1');
    // The receipt settles the control account in full; the document carries
    // an over-written amount_paid, as bank-match-confirm leaves behind.
    await postJournal(COMPANY_AR_PAID, bankId, receivableId, 1150.00, 'R086OP-JE-2');
    await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, gl_journal_entry_id, created_by
      ) VALUES (
        ${COMPANY_AR_PAID}::UUID, 'R086OP-CI-1', ${customer.id}::UUID, ${customer.id}::UUID, CURRENT_DATE, CURRENT_DATE,
        1000.00, 15.00, 150.00, 1150.00, 1200.00, 'paid', ${jeId}::UUID, ${USER_ID}::UUID
      )
    `;
    const results = await validateMigration(COMPANY_AR_PAID, 'r086-overpaid-ar');
    const ar = results.find(r => r.check === 'AR vs GL');
    expect(ar?.status).toBe('pass');
    expect(ar?.detail).toBe('R0.00');
  });
  it('AR vs GL passes for a negative-total document, which the clamp must not erase', async () => {
    const receivableId = await createGlAccount(COMPANY_AR_NEG, 'R086NG-AR-1200', 'receivable', 'asset', 'debit');
    const revenueId = await createGlAccount(COMPANY_AR_NEG, 'R086NG-AR-4000', 'default_revenue', 'revenue', 'credit');
    const [customer] = (await sql`
      INSERT INTO customers (name, company_id) VALUES ('R086NG Customer', ${COMPANY_AR_NEG}::UUID) RETURNING id
    `) as Array<{ id: string }>;
    // A credit-note-shaped row: CR receivable 1150.
    const jeId = await postJournal(COMPANY_AR_NEG, revenueId, receivableId, 1150.00, 'R086NG-JE-1');
    // Migration 692 (R-119) refuses a NEW negative total; rows in this shape
    // are in production from before it, which is what the clamp serves.
    // Seeded the way migration 664's rows are, through replica mode.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await insertPreConstraintRow(pool, `
        INSERT INTO customer_invoices (
          company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
          subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, gl_journal_entry_id, created_by
        ) VALUES ($1::UUID, 'R086NG-CI-1', $2::UUID, $2::UUID, CURRENT_DATE, CURRENT_DATE,
          -1000.00, 15.00, -150.00, -1150.00, 0, 'sent', $3::UUID, $4::UUID)`,
        [COMPANY_AR_NEG, customer.id, jeId, USER_ID]);
    } finally {
      await pool.end();
    }
    const results = await validateMigration(COMPANY_AR_NEG, 'r086-negative-ar');
    const ar = results.find(r => r.check === 'AR vs GL');
    expect(ar?.status).toBe('pass');
    expect(ar?.detail).toBe('R-1150.00');
  });
});
