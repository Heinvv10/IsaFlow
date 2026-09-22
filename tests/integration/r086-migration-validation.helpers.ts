/**
 * Shared fixture helpers for the R-086 migration-validation integration
 * tests. Real DB (fixture.env), no mocks. Each test file names its own
 * companies and cleans them BEFORE and after its run, so an aborted run
 * cannot leave rows that mask the next one.
 */
import { sql } from '@/lib/neon';

export const USER_ID = '00000000-0000-0000-0086-000000000001';
export const FUTURE_DATE_EXPR = "CURRENT_DATE + INTERVAL '90 days'";

export async function ensureCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'R086-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

export async function createGlAccount(companyId: string, code: string, subtype: string, type: string, normal: string): Promise<string> {
  const rows = (await sql`
    INSERT INTO gl_accounts (account_code, account_name, account_type, account_subtype, normal_balance, company_id)
    VALUES (${code}, ${'R086 ' + subtype}, ${type}, ${subtype}, ${normal}, ${companyId}::UUID)
    RETURNING id
  `) as Array<{ id: string }>;
  return rows[0]!.id;
}

export async function postJournal(companyId: string, debitAccountId: string, creditAccountId: string, amount: number, entryNumber: string): Promise<string> {
  return postJournalDated(companyId, debitAccountId, creditAccountId, amount, entryNumber, null);
}

/** `entryDate` null means CURRENT_DATE; otherwise an explicit SQL date expression (e.g. "CURRENT_DATE + INTERVAL '90 days'"). */
export async function postJournalDated(
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

export async function cleanupCompany(companyId: string): Promise<void> {
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

/** Clean each company first (an aborted earlier run leaves rows), then create it. */
export async function setupCompanies(companies: Array<[string, string]>): Promise<void> {
  for (const [id] of companies) await cleanupCompany(id);
  await Promise.all(companies.map(([id, name]) => ensureCompany(id, name)));
}

export async function teardownCompanies(companies: Array<[string, string]>): Promise<void> {
  for (const [id] of companies) await cleanupCompany(id);
}
