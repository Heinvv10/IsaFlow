/**
 * D7 round 3: fixture builder for the chain suites ported from the brk-d7
 * adversarial pass — one company per case, an open period per month of 2026
 * and 2027, AR/AP/VAT accounts, and the hand-reversal helpers.
 */
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { als } from '@/lib/als';
import { sql, getPoolForTests } from '@/lib/neon';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';

export interface Co {
  id: string; user: string; tag: string;
  receivable: string; payable: string; revenue: string; expense: string;
  vatOutput: string; vatInput: string; accrued: string; bank: string;
  customer: string; supplier: string;
}

export async function inTx<T>(co: Co, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPoolForTests().connect();
  try {
    await client.query('BEGIN');
    const result = await als.run({ client, userId: co.user, companyId: co.id, claims: {} }, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function account(co: Co, id: string, code: string, name: string, type: string, normal: string, subtype: string | null) {
  await sql`
    INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type,
      normal_balance, level, is_active, is_system_account, account_subtype)
    VALUES (${id}::UUID, ${co.id}::UUID, ${code}, ${name}, ${type}, ${normal}, 3, true, true, ${subtype})`;
}

/** A company with one open fiscal period per month of 2026 and 2027. */
export async function makeCompany(prefix: string, id?: string): Promise<Co> {
  const tag = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const co: Co = {
    id: id ?? randomUUID(), user: randomUUID(), tag,
    receivable: randomUUID(), payable: randomUUID(), revenue: randomUUID(), expense: randomUUID(),
    vatOutput: randomUUID(), vatInput: randomUUID(), accrued: randomUUID(), bank: randomUUID(),
    customer: '', supplier: '',
  };
  await sql`INSERT INTO companies (id, name, registration_number) VALUES (${co.id}::UUID, ${'D7CHAIN ' + tag}, ${tag})`;
  for (const y of [2026, 2027]) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
        VALUES (${co.id}::UUID, ${`D7CHAIN ${y}-${m} ${tag}`}, ${m}, ${y}, ${start}::date,
                (${start}::date + INTERVAL '1 month' - INTERVAL '1 day')::date, 'open')`;
    }
  }
  await account(co, co.receivable, '1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
  await account(co, co.payable, '2100', 'Trade Creditors', 'liability', 'credit', 'payable');
  await account(co, co.revenue, '4000', 'Sales', 'revenue', 'credit', 'default_revenue');
  await account(co, co.expense, '5000', 'Materials', 'expense', 'debit', 'default_expense');
  await account(co, co.vatOutput, '2200', 'VAT Output', 'liability', 'credit', 'vat_output');
  await account(co, co.vatInput, '1300', 'VAT Input', 'asset', 'debit', 'vat_input');
  await account(co, co.accrued, '2130', 'Accrued', 'liability', 'credit', null);
  await account(co, co.bank, '1000', 'Bank', 'asset', 'debit', 'bank');
  co.customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${co.id}::UUID, ${'cust ' + tag}) RETURNING id`) as { id: string }[])[0]!.id;
  co.supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${co.id}::UUID, ${'supp ' + tag}) RETURNING id`) as { id: string }[])[0]!.id;
  return co;
}

export async function arInvoice(co: Co, suffix: string, date: string, sub: number, vat: number): Promise<string> {
  const id = ((await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${co.id}::UUID, ${co.customer}::UUID, ${co.customer}::UUID, ${co.tag + suffix}, ${date}::date,
      ${date}::date, 'approved', ${sub}, 15, ${vat}, ${sub + vat}, 0, ${co.user}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await inTx(co, () => postCustomerInvoiceToGL(co.id, id, co.user));
  return id;
}

export async function apBill(co: Co, suffix: string, date: string, sub: number, vat: number): Promise<string> {
  const id = ((await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${co.id}::UUID, ${co.supplier}::UUID, ${co.tag + suffix}, ${date}::date, ${date}::date,
      'approved', ${sub}, ${vat}, ${sub + vat}, 0, ${co.user}::UUID)
    RETURNING id`) as { id: string }[])[0]!.id;
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, ${'d7 line'}, 1, ${sub}, 15, ${vat}, ${sub}, ${co.expense}::UUID)`;
  await inTx(co, () => postSupplierInvoiceToGL(co.id, id, co.user));
  return id;
}

export async function journalOf(co: Co, id: string): Promise<string> {
  return ((await sql`
    SELECT gl_journal_entry_id AS j FROM customer_invoices WHERE company_id = ${co.id}::UUID AND id = ${id}::UUID
    UNION ALL
    SELECT gl_journal_entry_id FROM supplier_invoices WHERE company_id = ${co.id}::UUID AND id = ${id}::UUID`) as { j: string }[])[0]!.j;
}

/** The un-reversed posted tip of a journal's reversal chain, and its date. */
export async function chainTip(co: Co, root: string): Promise<{ id: string; date: string; depth: number }> {
  let cur = root; let depth = 1;
  for (;;) {
    const next = (await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${co.id}::UUID
      AND reversal_of_id = ${cur}::UUID AND status = 'posted'`) as { id: string }[];
    if (next.length === 0) break;
    cur = next[0]!.id; depth++;
  }
  const d = (await sql`SELECT entry_date::text AS d FROM gl_journal_entries WHERE id = ${cur}::UUID`) as { d: string }[];
  return { id: cur, date: d[0]!.d, depth };
}

export async function reverseTip(co: Co, root: string, reversalDate?: string): Promise<string> {
  const tip = await chainTip(co, root);
  const r = await inTx(co, () => reverseJournalEntry(co.id, tip.id, co.user, reversalDate ? { reversalDate } : undefined));
  return r.id;
}

/**
 * The DB guard for the chain suites. They forge corrupt reversal chains, so
 * they run only against a disposable LOCAL fixture database:
 * `isaflow_schema_fixture`, or `isaflow_test` — the second name the fixture
 * containers carry for the suites that demand it (assertNotProductionDb).
 * The URL is checked the way pg will read it (fixtureDbGuard): no query
 * parameter but sslmode, so `?host=` cannot point a "localhost" URL at another
 * server; localhost only; not the IsaFlow Supabase stack's ports; and one of
 * those two names, which the dev/production server does not carry. Unlike
 * `assertDisposable` (route suites), these suites never call GoTrue or the
 * platform-admin pool, so those URLs are not required.
 */
export function assertChainFixtureDb(): void {
  if (process.env.ISAFLOW_DISPOSABLE_AUTH_TEST !== '1') {
    throw new Error('Disposable opt-in required: ISAFLOW_DISPOSABLE_AUTH_TEST=1');
  }
  assertLocalFixtureDbUrl('DATABASE_URL', process.env.DATABASE_URL, ['isaflow_schema_fixture', 'isaflow_test']);
}

/**
 * Clean every company even when one fails, then report every failure. Forged
 * links are undone across the WHOLE set first: a case that fails before it
 * un-forges a cross-tenant link (one company's entry reversing another's)
 * otherwise leaves a `reversal_of_id` foreign key that blocks deleting the
 * other company's journals, and every company after it was stranded.
 */
export async function cleanupAll(cos: readonly Co[]): Promise<void> {
  const failures: string[] = [];
  const ids = cos.map((co) => co.id);
  try {
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ANY(${ids}::uuid[])`;
  } catch (err) {
    failures.push(`unlink: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const co of cos) {
    try {
      await cleanup(co);
    } catch (err) {
      failures.push(`${co.tag}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(`cleanup failed for ${failures.length} company(ies): ${failures.join('; ')}`);
}

export async function cleanup(co: Co): Promise<void> {
  const c = co.id;
  await sql`DELETE FROM soft_delete_journal_reversals WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM vat_returns WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM vat_period_locks WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM customer_payments WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM supplier_payments WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM credit_notes WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM customer_invoices WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM supplier_invoices WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_journal_lines WHERE company_id = ${c}::UUID`;
  await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${c}::UUID)`;
  await sql`DELETE FROM gl_accounts WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM fiscal_periods WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM customers WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM suppliers WHERE company_id = ${c}::UUID`;
  await sql`DELETE FROM companies WHERE id = ${c}::UUID`;
}
