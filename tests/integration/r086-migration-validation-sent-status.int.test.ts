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
import {
  USER_ID, FUTURE_DATE_EXPR, createGlAccount, postJournal, postJournalDated, setupCompanies, teardownCompanies,
} from './r086-migration-validation.helpers';

const COMPANY_AR = '00000000-0000-0000-0086-0000000000a1';
const COMPANY_AP = '00000000-0000-0000-0086-0000000000a2';
const COMPANY_AR_SOFTDEL = '00000000-0000-0000-0086-0000000000a3';
const COMPANY_AP_SOFTDEL = '00000000-0000-0000-0086-0000000000a4';
const COMPANY_AR_EXCL = '00000000-0000-0000-0086-0000000000a5';
const COMPANY_AP_EXCL = '00000000-0000-0000-0086-0000000000a6';
const COMPANIES: Array<[string, string]> = [
  ['00000000-0000-0000-0086-0000000000a1', 'R086 Test Company AR'],
  ['00000000-0000-0000-0086-0000000000a2', 'R086 Test Company AP'],
  ['00000000-0000-0000-0086-0000000000a3', 'R086 Test Company AR Soft-Delete'],
  ['00000000-0000-0000-0086-0000000000a4', 'R086 Test Company AP Soft-Delete'],
  ['00000000-0000-0000-0086-0000000000a5', 'R086 Test Company AR Exclusion'],
  ['00000000-0000-0000-0086-0000000000a6', 'R086 Test Company AP Exclusion'],
];

beforeAll(() => setupCompanies(COMPANIES));
afterAll(() => teardownCompanies(COMPANIES));

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

