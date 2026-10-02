/**
 * D8 round 4: the adversarial round's (brk-d8, on 752ad8640) shared fixture,
 * kept as the regression suite for its findings. Each suite seeds its own
 * companies through seedFixture; like the brk round, nothing is torn down
 * (run on a disposable fixture DB only — assertNotProductionDb guards it).
 */
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { processSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { createCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentService';
import { confirmCustomerPayment } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { dropFixture, inTx, runOn, seedFixture, type Fixture } from './helpers/l1FifoFixture';

type Row = Record<string, unknown>;
export interface Ctx { fx: Fixture; acct: Record<string, string>; seq: number }

export async function setup(prefix: string): Promise<Ctx> {
  const fx = await seedFixture(prefix, process.env.DATABASE_URL!);
  const acct: Record<string, string> = {};
  for (const [k, sub] of [['ar', 'receivable'], ['ap', 'payable'], ['expense', 'default_expense'], ['bank', 'bank'],
    ['vatIn', 'vat_input'], ['vatOut', 'vat_output']]) {
    acct[k] = String(((await sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${sub}`) as Row[])[0]!.id);
  }
  const extra = (await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true),
           (${fx.companyId}::UUID, '3900', ${`Opening equity ${fx.tag}`}, 'equity', 'opening_balance_equity', 'credit', true, true)
    RETURNING id, account_code`) as Row[];
  acct.sales = String(extra.find((r) => r.account_code === '4000')!.id);
  acct.equity = String(extra.find((r) => r.account_code === '3900')!.id);
  return { fx, acct, seq: 0 };
}

/** Trial balance (posted net, debit - credit) per named account. */
export async function tb(c: Ctx): Promise<Record<string, number>> {
  const rows = (await sql`
    SELECT l.gl_account_id::TEXT AS a, COALESCE(SUM(l.debit - l.credit), 0)::float8 AS n
    FROM gl_journal_lines l JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${c.fx.companyId}::UUID AND e.company_id = ${c.fx.companyId}::UUID AND e.status = 'posted'
    GROUP BY l.gl_account_id`) as Row[];
  const out: Record<string, number> = {};
  for (const [k, id] of Object.entries(c.acct)) {
    out[k] = Math.round(Number(rows.find((r) => r.a === id)?.n ?? 0) * 100) / 100;
  }
  return out;
}

export const diff = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(Object.keys(a).map((k) => [k, Math.round((b[k]! - a[k]!) * 100) / 100]));

/** Reverse `id` k times through the product; returns every id in the chain, root first. */
export async function buildChain(c: Ctx, root: string, k: number): Promise<string[]> {
  const ids = [root];
  for (let i = 0; i < k; i++) {
    ids.push((await inTx(c.fx, () => reverseJournalEntry(c.fx.companyId, ids[ids.length - 1]!, c.fx.userId))).id);
  }
  return ids;
}

export async function postedReversalsOf(c: Ctx, id: string): Promise<string[]> {
  return ((await sql`
    SELECT id FROM gl_journal_entries
    WHERE company_id = ${c.fx.companyId}::UUID AND reversal_of_id = ${id}::UUID AND status = 'posted'`) as Row[])
    .map((r) => String(r.id));
}

export async function postedInvoice(c: Ctx, date = '2026-05-10'): Promise<{ id: string; je: string }> {
  const [i] = (await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.customerId}::UUID, ${c.fx.customerId}::UUID, ${`D8R4-I-${++c.seq}-${c.fx.tag}`},
      ${date}::DATE, ${date}::DATE, 'approved', 1000, 15, 150, 1150, 0, ${c.fx.userId}::UUID)
    RETURNING id`) as Row[];
  const id = String(i!.id);
  await inTx(c.fx, () => postCustomerInvoiceToGL(c.fx.companyId, id, c.fx.userId));
  const [j] = (await sql`SELECT gl_journal_entry_id AS j FROM customer_invoices WHERE id = ${id}::UUID`) as Row[];
  return { id, je: String(j!.j) };
}

export async function postedBill(c: Ctx): Promise<{ id: string; je: string }> {
  const [b] = (await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.supplierId}::UUID, ${`D8R4-B-${++c.seq}-${c.fx.tag}`}, '2026-05-10', '2026-06-10',
      'approved', 1000, 150, 1150, 0, ${c.fx.userId}::UUID)
    RETURNING id`) as Row[];
  const id = String(b!.id);
  await sql`
    INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, gl_account_id)
    VALUES (${id}::UUID, 'd8r4 line', 1, 1000, 15, 150, 1000, ${c.acct.expense}::UUID)`;
  await inTx(c.fx, () => postSupplierInvoiceToGL(c.fx.companyId, id, c.fx.userId));
  const [j] = (await sql`SELECT gl_journal_entry_id AS j FROM supplier_invoices WHERE id = ${id}::UUID`) as Row[];
  return { id, je: String(j!.j) };
}

export async function processedPayment(c: Ctx, billId: string, amount: number): Promise<{ id: string; je: string }> {
  const [p] = (await sql`
    INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount, status,
      payment_method, bank_account_id, created_by)
    VALUES (${c.fx.companyId}::UUID, ${`D8P${++c.seq}-${c.fx.tag.slice(-12)}`}, ${c.fx.supplierId}::UUID, '2026-05-20', ${amount},
      'approved', 'eft', ${c.fx.bankAccountId}::UUID, ${c.fx.userId}::UUID)
    RETURNING id`) as Row[];
  const id = String(p!.id);
  await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${id}::UUID, ${billId}::UUID, ${amount})`;
  await inTx(c.fx, () => processSupplierPayment(c.fx.companyId, id, c.fx.userId));
  const [j] = (await sql`SELECT gl_journal_entry_id AS j FROM supplier_payments WHERE id = ${id}::UUID`) as Row[];
  return { id, je: String(j!.j) };
}

/** A transaction left OPEN after `fn` completes, so another connection can interleave. */
export async function openTx<T>(fx: Fixture, fn: () => Promise<T>, client?: PoolClient) {
  const cl = client ?? await fx.pool.connect();
  await cl.query('BEGIN');
  let value: T;
  try {
    value = await runOn(fx, cl, fn);
  } catch (err) {
    await cl.query('ROLLBACK');
    cl.release();
    throw err;
  }
  return {
    value,
    commit: async () => { await cl.query('COMMIT'); cl.release(); },
    rollback: async () => { await cl.query('ROLLBACK'); cl.release(); },
  };
}

/** Settle a promise into {ok, value|error} so a refused flow is evidence, not a crash. */
export async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: `${(err as Error).name}: ${(err as Error).message}` };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Remove a context's company: reversal links into it first (a forged row elsewhere may point here). */
export async function teardown(c: Ctx | undefined): Promise<void> {
  if (!c) return;
  const id = c.fx.companyId;
  await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL
            WHERE company_id = ${id}::UUID
               OR reversal_of_id IN (SELECT id FROM gl_journal_entries WHERE company_id = ${id}::UUID)`;
  await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (
              SELECT id FROM supplier_invoices WHERE company_id = ${id}::UUID)`;
  await sql`DELETE FROM migration_sessions WHERE company_id = ${id}::UUID`;
  await dropFixture(c.fx);
}

/** A confirmed customer receipt of R`amount` against `invoiceId`, through the real workflow. */
export async function confirmedReceipt(c: Ctx, invoiceId: string, amount: number): Promise<{ id: string; je: string }> {
  const p = await inTx(c.fx, () => createCustomerPayment(c.fx.companyId, {
    clientId: c.fx.customerId, paymentDate: '2026-05-20', totalAmount: amount, paymentMethod: 'eft',
    bankAccountId: c.fx.bankAccountId, allocations: [{ invoiceId, amount }],
  }, c.fx.userId));
  await inTx(c.fx, () => confirmCustomerPayment(c.fx.companyId, p.id, c.fx.userId));
  const [j] = (await sql`SELECT gl_journal_entry_id AS j FROM customer_payments WHERE id = ${p.id}::UUID`) as Row[];
  return { id: p.id, je: String(j!.j) };
}

/** A bank-first provisional as postProvisional leaves it: DR expense / CR bank, needs_evidence, its line 'provisional'. */
export async function provisional(c: Ctx, amount: number): Promise<{ je: string; bt: string }> {
  const draft = await inTx(c.fx, () => createJournalEntry(c.fx.companyId, {
    entryDate: '2026-05-15', description: `D8R4 provisional ${++c.seq}`, source: 'auto_bank_recon',
    lines: [{ glAccountId: c.acct.expense!, debit: amount, credit: 0 }, { glAccountId: c.fx.bankAccountId, debit: 0, credit: amount }],
  }, c.fx.userId));
  await sql`UPDATE gl_journal_entries SET needs_evidence = true WHERE id = ${draft.id}::UUID AND company_id = ${c.fx.companyId}::UUID`;
  await inTx(c.fx, () => postJournalEntry(c.fx.companyId, draft.id, c.fx.userId));
  const [bt] = (await sql`
    INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, provisional_je_id)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, '2026-05-15', ${-amount}, ${`D8R4 PROV ${c.seq}`},
            'provisional', ${draft.id}::UUID)
    RETURNING id`) as Row[];
  return { je: draft.id, bt: String(bt!.id) };
}
