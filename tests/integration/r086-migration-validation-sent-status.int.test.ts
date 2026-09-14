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

const COMPANY_AR = '00000000-0000-0000-0086-0000000000a1';
const COMPANY_AP = '00000000-0000-0000-0086-0000000000a2';
const USER_ID = '00000000-0000-0000-0086-000000000001';

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

async function postJournal(companyId: string, debitAccountId: string, creditAccountId: string, amount: number, entryNumber: string): Promise<void> {
  const je = (await sql`
    INSERT INTO gl_journal_entries (entry_number, entry_date, description, source, status, created_by, company_id)
    VALUES (${entryNumber}, CURRENT_DATE, 'R086 test entry', 'manual', 'posted', ${USER_ID}::UUID, ${companyId}::UUID)
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
}

async function cleanupCompany(companyId: string): Promise<void> {
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM customer_invoices WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM gl_accounts WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM customers WHERE company_id = ${companyId}::UUID`;
  await sql`DELETE FROM suppliers WHERE company_id = ${companyId}::UUID`;
}

beforeAll(async () => {
  await Promise.all([
    ensureCompany(COMPANY_AR, 'R086 Test Company AR'),
    ensureCompany(COMPANY_AP, 'R086 Test Company AP'),
  ]);
});

afterAll(async () => {
  await cleanupCompany(COMPANY_AR);
  await cleanupCompany(COMPANY_AP);
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
