/**
 * Integration test: R-086 — migrationValidationService's AR/AP-vs-GL checks
 * used a hand-written status list that omitted 'sent' (AR) and excluded a
 * document merely by not being on the list (AP), so a posted, migrated
 * invoice in status 'sent' failed the AR-vs-GL / AP-vs-GL reconciliation
 * even though the GL and the subledger agree.
 *
 * Fix: both checks now share the population rule from
 * shared/documentPopulation.documentInPopulationExpr (R-059/R-082) — a
 * document is IN the population unless it is draft, pending_approval or
 * cancelled. 'sent' (AR) and any other posted status are included, so this
 * list can never drift out of step with the ageing/subledger again.
 *
 * Real DB (fixture.env) — no mocks.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { validateMigration } from '@/modules/accounting/services/core/migrationValidationService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';

const COMPANY_AR = '00000000-0000-0000-0086-0000000000a1';
const COMPANY_AP = '00000000-0000-0000-0086-0000000000a2';
const COMPANY_AR_SOFTDEL = '00000000-0000-0000-0086-0000000000a3';
const COMPANY_AP_SOFTDEL = '00000000-0000-0000-0086-0000000000a4';
const COMPANY_AR_EXCL = '00000000-0000-0000-0086-0000000000a5';
const COMPANY_AP_EXCL = '00000000-0000-0000-0086-0000000000a6';
const COMPANY_AR_FUTURE_LIVE = '00000000-0000-0000-0086-0000000000a7';
const COMPANY_AP_FUTURE_LIVE = '00000000-0000-0000-0086-0000000000a8';
const COMPANY_AR_FUTURE_DEL = '00000000-0000-0000-0086-0000000000a9';
const COMPANY_AP_FUTURE_DEL = '00000000-0000-0000-0086-0000000000aa';
const COMPANY_AR_ORDER = '00000000-0000-0000-0086-0000000000ab';
const USER_ID = '00000000-0000-0000-0086-000000000001';
const FUTURE_DATE_EXPR = "CURRENT_DATE + INTERVAL '90 days'";

async function ensureCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'R086-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createGlAccount(companyId: string, code: string, subtype: string, type: string, normal: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_accounts (account_code, account_name, account_type, account_subtype, normal_balance, company_id)
    VALUES (${code}, ${'R086 ' + subtype}, ${type}, ${subtype}, ${normal}, ${companyId}::UUID)
    RETURNING id
  `) as Array<{ id: string }>;
  return rows[0]!.id;
}

async function postJournal(companyId: string, debitAccountId: string, creditAccountId: string, amount: number, entryNumber: string): Promise<string> {
  return postJournalDated(companyId, debitAccountId, creditAccountId, amount, entryNumber, null);
}

/** `entryDate` null means CURRENT_DATE; otherwise an explicit SQL date expression (e.g. "CURRENT_DATE + INTERVAL '90 days'"). */
async function postJournalDated(
  companyId: string, debitAccountId: string, creditAccountId: string, amount: number,
  entryNumber: string, entryDate: string | null,
): Promise<string> {
  const dateExpr = entryDate ?? 'CURRENT_DATE';
  const je = (await sql`
    INSERT INTO gl_journal_entries (entry_number, entry_date, description, source, status, created_by, company_id)
    VALUES (${entryNumber}, ${sql.unsafe(dateExpr)}, 'R086 test entry', 'manual', 'posted', ${USER_ID}::UUID, ${companyId}::UUID)
    RETURNING id
  `) as Array<{ id: string }>;
  const jeId = je[0]!.id;
  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
    VALUES (${jeId}::UUID, ${debitAccountId}::UUID, ${amount}, 0, ${companyId}::UUID)
  `;
  await sql`
    INSERT INTO gl_journal_lines (journal_entry_id, gl_account_id, debit, credit, company_id)
    VALUES (${jeId}::UUID, ${creditAccountId}::UUID, 0, ${amount}, ${companyId}::UUID)
  `;
  return jeId;
}

async function cleanupCompany(companyId: string): Promise<void> {
  // FK-safe order: invoices (reference gl_journal_entries) and the reversal
  // ledger and balances rows before the journal entries and accounts they
  // point at.
  await sql`
    DELETE FROM soft_delete_journal_reversals
    WHERE reversal_journal_entry_id IN (
      SELECT id FROM gl_journal_entries WHERE company_id = ${companyId}::UUID
    )
  `;
  await sql`DELETE FROM customer_invoices WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE company_id = ${companyId}::UUID`;
  // trg_gl_jl_balance_update (AFTER DELETE on gl_journal_lines) recreates a
  // gl_account_balances row as a side effect of this very delete, so that
  // table has to be cleared AFTER gl_journal_lines is gone, not before.
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${companyId}::UUID`;
  await sql`
    DELETE FROM gl_account_balances
    WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${companyId}::UUID)
  `;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM gl_accounts WHERE company_id = ${companyId}::UUID`;
  // Auto-created fiscal years/periods otherwise outlive the company's other
  // rows and leave the NEXT run against this same company id with an
  // already-open period for a date that should be fresh — exactly the
  // "second run masks it" trap review round 3 warned about.
  await sql`DELETE FROM fiscal_periods WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM customers WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM suppliers WHERE company_id = ${companyId}::UUID`;
}

beforeAll(async () => {
  await Promise.all([
    ensureCompany(COMPANY_AR, 'R086 Test Company AR'),
    ensureCompany(COMPANY_AP, 'R086 Test Company AP'),
    ensureCompany(COMPANY_AR_SOFTDEL, 'R086 Test Company AR Soft-Delete'),
    ensureCompany(COMPANY_AP_SOFTDEL, 'R086 Test Company AP Soft-Delete'),
    ensureCompany(COMPANY_AR_EXCL, 'R086 Test Company AR Exclusion'),
    ensureCompany(COMPANY_AP_EXCL, 'R086 Test Company AP Exclusion'),
    ensureCompany(COMPANY_AR_FUTURE_LIVE, 'R086 Test Company AR Future Live'),
    ensureCompany(COMPANY_AP_FUTURE_LIVE, 'R086 Test Company AP Future Live'),
    ensureCompany(COMPANY_AR_FUTURE_DEL, 'R086 Test Company AR Future Deleted'),
    ensureCompany(COMPANY_AP_FUTURE_DEL, 'R086 Test Company AP Future Deleted'),
    ensureCompany(COMPANY_AR_ORDER, 'R086 Test Company AR Out-Of-Order Chain'),
  ]);
});

afterAll(async () => {
  await cleanupCompany(COMPANY_AR);
  await cleanupCompany(COMPANY_AP);
  await cleanupCompany(COMPANY_AR_SOFTDEL);
  await cleanupCompany(COMPANY_AP_SOFTDEL);
  await cleanupCompany(COMPANY_AR_EXCL);
  await cleanupCompany(COMPANY_AP_EXCL);
  await cleanupCompany(COMPANY_AR_FUTURE_LIVE);
  await cleanupCompany(COMPANY_AP_FUTURE_LIVE);
  await cleanupCompany(COMPANY_AR_FUTURE_DEL);
  await cleanupCompany(COMPANY_AP_FUTURE_DEL);
  await cleanupCompany(COMPANY_AR_ORDER);
});

describe('R-086: migration validation AR/AP-vs-GL includes a posted "sent"/non-excluded document', () => {
  it('AR vs GL passes for a posted customer invoice in status "sent"', async () => {
    const receivableId = await createGlAccount(COMPANY_AR, 'R086-AR-1200', 'receivable', 'asset', 'debit');
    const revenueId = await createGlAccount(COMPANY_AR, 'R086-AR-4000', 'default_revenue', 'revenue', 'credit');

    const [customer] = (await sql`
      INSERT INTO customers (name, company_id) VALUES ('R086 Customer', ${COMPANY_AR}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY_AR}::UUID, 'R086-CI-1', ${customer.id}::UUID, ${customer.id}::UUID,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'sent', ${USER_ID}::UUID
      )
    `;

    await postJournal(COMPANY_AR, receivableId, revenueId, 1150.00, 'R086-JE-AR-1');

    const results = await validateMigration(COMPANY_AR, 'r086-session-ar');
    const arCheck = results.find(r => r.check === 'AR vs GL');

    expect(arCheck).toBeDefined();
    expect(arCheck!.status).toBe('pass');
  });

  it('AP vs GL passes for a posted supplier invoice in status "disputed" (the AP twin of the AR "sent" gap)', async () => {
    const payableId = await createGlAccount(COMPANY_AP, 'R086-AP-2100', 'payable', 'liability', 'credit');
    const expenseId = await createGlAccount(COMPANY_AP, 'R086-AP-5000', 'default_expense', 'expense', 'debit');

    const [supplier] = (await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R086 Supplier', ${COMPANY_AP}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY_AP}::UUID, 'R086-SI-1', ${supplier.id}::UUID,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'disputed', ${USER_ID}::UUID
      )
    `;

    await postJournal(COMPANY_AP, expenseId, payableId, 1150.00, 'R086-JE-AP-1');

    const results = await validateMigration(COMPANY_AP, 'r086-session-ap');
    const apCheck = results.find(r => r.check === 'AP vs GL');

    expect(apCheck).toBeDefined();
    expect(apCheck!.status).toBe('pass');
  });
});

describe('R-086 review round 1, MEDIUM-1: a soft-deleted invoice must not count on the invoice side once its journal is reversed', () => {
  it('AR vs GL still passes after a "sent" invoice is soft-deleted (journal reversed, status unchanged)', async () => {
    const receivableId = await createGlAccount(COMPANY_AR_SOFTDEL, 'R086SD-AR-1200', 'receivable', 'asset', 'debit');
    const revenueId = await createGlAccount(COMPANY_AR_SOFTDEL, 'R086SD-AR-4000', 'default_revenue', 'revenue', 'credit');

    const [customer] = (await sql`
      INSERT INTO customers (name, company_id) VALUES ('R086SD Customer', ${COMPANY_AR_SOFTDEL}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    const jeId = await postJournal(COMPANY_AR_SOFTDEL, receivableId, revenueId, 1150.00, 'R086SD-JE-AR-1');

    const [invoice] = (await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, gl_journal_entry_id, created_by
      ) VALUES (
        ${COMPANY_AR_SOFTDEL}::UUID, 'R086SD-CI-1', ${customer.id}::UUID, ${customer.id}::UUID,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'sent', ${jeId}::UUID, ${USER_ID}::UUID
      ) RETURNING id
    `) as Array<{ id: string }>;

    // softDelete reverses the approval journal (control account nets to 0)
    // but leaves `status` as it was ('sent') — exactly the shape the review
    // measured as a regression: the status half of the population rule alone
    // still counts this invoice's balance while the GL no longer carries it.
    await softDelete(COMPANY_AR_SOFTDEL, 'customer_invoice', invoice.id, USER_ID);

    const results = await validateMigration(COMPANY_AR_SOFTDEL, 'r086-softdel-ar');
    const arCheck = results.find(r => r.check === 'AR vs GL');

    expect(arCheck).toBeDefined();
    expect(arCheck!.status).toBe('pass');
  });

  it('AP vs GL still passes after a "disputed" invoice is soft-deleted (journal reversed, status unchanged)', async () => {
    const payableId = await createGlAccount(COMPANY_AP_SOFTDEL, 'R086SD-AP-2100', 'payable', 'liability', 'credit');
    const expenseId = await createGlAccount(COMPANY_AP_SOFTDEL, 'R086SD-AP-5000', 'default_expense', 'expense', 'debit');

    const [supplier] = (await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R086SD Supplier', ${COMPANY_AP_SOFTDEL}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    const jeId = await postJournal(COMPANY_AP_SOFTDEL, expenseId, payableId, 1150.00, 'R086SD-JE-AP-1');

    const [invoice] = (await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, gl_journal_entry_id, created_by
      ) VALUES (
        ${COMPANY_AP_SOFTDEL}::UUID, 'R086SD-SI-1', ${supplier.id}::UUID,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'disputed', ${jeId}::UUID, ${USER_ID}::UUID
      ) RETURNING id
    `) as Array<{ id: string }>;

    await softDelete(COMPANY_AP_SOFTDEL, 'supplier_invoice', invoice.id, USER_ID);

    const results = await validateMigration(COMPANY_AP_SOFTDEL, 'r086-softdel-ap');
    const apCheck = results.find(r => r.check === 'AP vs GL');

    expect(apCheck).toBeDefined();
    expect(apCheck!.status).toBe('pass');
  });
});

describe('R-086 review round 1, LOW-2: the exclusion side of the population rule — a draft/cancelled document must stay OUT', () => {
  it('AR vs GL passes when the only invoice is a draft with no posted GL (a mutant admitting drafts would fail this)', async () => {
    await sql`
      INSERT INTO customers (name, company_id) VALUES ('R086EX Customer', ${COMPANY_AR_EXCL}::UUID)
    `;
    const [customer] = (await sql`
      SELECT id FROM customers WHERE company_id = ${COMPANY_AR_EXCL}::UUID LIMIT 1
    `) as Array<{ id: string }>;

    // A draft invoice is never posted, so it has no GL entry at all. If the
    // exclusion side of the population rule were broken (e.g. replaced with
    // TRUE), this R1150 balance would count on the invoice side against a
    // GL balance of R0, and the check would wrongly FAIL.
    await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY_AR_EXCL}::UUID, 'R086EX-CI-1', ${customer.id}::UUID, ${customer.id}::UUID,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'draft', ${USER_ID}::UUID
      )
    `;

    const results = await validateMigration(COMPANY_AR_EXCL, 'r086-excl-ar');
    const arCheck = results.find(r => r.check === 'AR vs GL');

    expect(arCheck).toBeDefined();
    expect(arCheck!.status).toBe('pass');
  });

  it('AP vs GL passes when the only invoice is cancelled with no posted GL (a mutant admitting cancelled would fail this)', async () => {
    const [supplier] = (await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R086EX Supplier', ${COMPANY_AP_EXCL}::UUID) RETURNING id
    `) as Array<{ id: string }>;

    await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY_AP_EXCL}::UUID, 'R086EX-SI-1', ${supplier.id}::UUID,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00, 0, 'cancelled', ${USER_ID}::UUID
      )
    `;

    const results = await validateMigration(COMPANY_AP_EXCL, 'r086-excl-ap');
    const apCheck = results.find(r => r.check === 'AP vs GL');

    expect(apCheck).toBeDefined();
    expect(apCheck!.status).toBe('pass');
  });
});

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
  // Reproducing the precondition violation through the real softDelete/
  // resolveReversalDate path is racy: whether the fallback actually lands on
  // TODAY instead of the future original's date depends on whether that
  // date's fiscal period was already open at the moment of the check (see
  // the "future-dated" tests above, which exercise the real path and pass
  // regardless — but don't reliably PROVE this fix handles the violated
  // precondition, because the violation may or may not occur that run).
  // This test builds the illegal chain directly in SQL instead — the same
  // technique tests/integration/k053-out-of-order-reversal-chain.int.test.ts
  // uses to pin documentInLedgerAsAtFragment's own precondition — so the
  // proof does not depend on timing.
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
    // No code path can produce this through reverseJournalEntry/
    // resolveReversalDate (it refuses an explicit earlier date, and the
    // auto-created fiscal year makes the default path pick the original's
    // own date once that period exists); built directly to make the proof
    // deterministic, exactly as k053-out-of-order-reversal-chain.int.test.ts
    // does for the predicate itself.
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
});
