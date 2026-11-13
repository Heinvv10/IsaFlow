/**
 * Fixture for bank-reallocate-reconciled.int.test.ts: a statement line allocated through the product, reconciled
 * by a COMPLETED reconciliation (start -> review -> complete, the services the screen calls), on a bank account of
 * its own; the MCP tool called through a real McpRegistry, as the transport calls it. And the read-backs the
 * invariants compare.
 */
import { sql } from '@/lib/neon';
import { McpRegistry } from '@/lib/mcp/registry';
import type { McpToolResult } from '@/lib/mcp/types';
import { reallocateBankTransactionTool } from '@/lib/mcp/tools/writeBankReallocate';
import { reverseBankAllocationTool } from '@/lib/mcp/tools/writeBankAllocate';
import { allocateTransaction, type AllocationType } from '@/modules/accounting/services/bank/bankAllocationService';
import { completeReconciliation, startReconciliation } from '@/modules/accounting/services/bank/bankReconciliationService';
import { bankGlBalanceAsAt } from '@/modules/accounting/services/bank/bankReconciliationBalance';
import { postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { inTx } from './helpers/l1FifoFixture';
import { setup, type Ctx } from './d8-r4-helpers';

type Row = Record<string, unknown>;
export const REVIEWED_AT = '2026-07-01T08:00:00.000Z';
export const TOOL = 'reallocate_bank_transaction';

/** The d8-r4 fixture plus a users row (audit_log.user_id) and an owner membership. */
export async function setupCompany(prefix: string): Promise<Ctx> {
  const c = await setup(prefix);
  await sql`INSERT INTO users (id, email, first_name) VALUES (${c.fx.userId}, ${`${prefix.toLowerCase()}-${c.fx.tag}@example.invalid`}, 'realloc')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${c.fx.companyId}::UUID, ${c.fx.userId}, 'owner')`;
  return c;
}

export async function newBank(c: Ctx): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance,
      is_active, is_system_account)
    VALUES (${c.fx.companyId}::UUID, ${`8${String(++c.seq).padStart(3, '0')}`}, ${`Realloc bank ${c.seq} ${c.fx.tag}`},
      'asset', 'bank', 'debit', true, false) RETURNING id`) as Row[])[0]!.id);
}

export async function newSupplier(c: Ctx): Promise<string> {
  return String(((await sql`INSERT INTO suppliers (name, company_id) VALUES (${`Realloc SUP ${++c.seq} ${c.fx.tag}`},
    ${c.fx.companyId}::UUID) RETURNING id`) as Row[])[0]!.id);
}

/** An approved bill of `total` (expense, no VAT) posted to the GL through the product. */
export async function postedBill(c: Ctx, supplierId: string, date: string, total: number): Promise<string> {
  const [b] = (await sql`
    INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, status,
      subtotal, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${c.fx.companyId}::UUID, ${supplierId}::UUID, ${`RA-B-${++c.seq}-${c.fx.tag}`}, ${date}::DATE, ${date}::DATE,
      'approved', ${total}, 0, ${total}, 0, ${c.fx.userId}::UUID) RETURNING id`) as Row[];
  const id = String(b!.id);
  await sql`INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount,
      line_total, gl_account_id) VALUES (${id}::UUID, 'realloc line', 1, ${total}, 0, 0, ${total}, ${c.acct.expense}::UUID)`;
  await inTx(c.fx, () => postSupplierInvoiceToGL(c.fx.companyId, id, c.fx.userId));
  return id;
}

export async function bankGl(c: Ctx, bank: string, asAt: string): Promise<number> {
  return Number(((await bankGlBalanceAsAt(c.fx.companyId, sql`${bank}::UUID`, sql`${asAt}`)) as Row[])[0]!.gl_balance);
}

/**
 * A line of `amount` on its own bank, allocated (`alloc`), then reconciled by a completed reconciliation to
 * `statementDate`, reviewed at REVIEWED_AT by the fixture user.
 */
export async function reconciledLine(c: Ctx, o: {
  amount: number; date: string; statementDate: string; alloc: AllocationType; contra?: string; entity?: string;
}) {
  const bank = await newBank(c);
  const bt = String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount,
      description, status) VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, ${o.date}::DATE, ${o.amount},
      ${`Realloc ${++c.seq}`}, 'imported') RETURNING id`) as Row[])[0]!.id);
  const posted = await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, o.contra ?? null, c.fx.userId, undefined,
    o.alloc, o.entity, 'none'));
  const balance = await bankGl(c, bank, o.statementDate);
  const rec = await inTx(c.fx, () => startReconciliation(c.fx.companyId, bank, o.statementDate, balance, c.fx.userId));
  await sql`UPDATE bank_transactions SET reviewed_at = ${REVIEWED_AT}::TIMESTAMPTZ, reviewed_by = ${c.fx.userId}::UUID
    WHERE id = ${bt}::UUID`;
  await inTx(c.fx, () => completeReconciliation(c.fx.companyId, rec.id, c.fx.userId));
  return { bank, bt, rec: rec.id, je: posted.journalEntryId };
}

const registry = new McpRegistry();
registry.register(reallocateBankTransactionTool);
registry.register(reverseBankAllocationTool);

export interface Reply { isError: boolean; text: string; body: Record<string, unknown> | null }

export async function mcp(c: Ctx, name: string, args: Record<string, unknown>): Promise<Reply> {
  const r: McpToolResult = await inTx(c.fx, () => registry.call(name, args, {
    userId: c.fx.userId, companyId: c.fx.companyId, scopes: ['write:bank-tx', 'write:post'], companyRole: 'owner',
    tokenJti: null, oauthAppId: null,
  }));
  const text = r.content[0]!.text;
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = null; }
  return { isError: r.isError === true, text, body };
}

/** The reconciliation row exactly as stored. */
export async function recRow(rec: string): Promise<string> {
  return String(((await sql`SELECT row_to_json(r)::TEXT AS j FROM bank_reconciliations r WHERE id = ${rec}::UUID`) as Row[])[0]!.j);
}

export async function lineRow(bt: string) {
  return ((await sql`SELECT status, reconciliation_id::TEXT AS rec, matched_journal_line_id::TEXT AS jl, allocation_type,
      reviewed_at, reviewed_by::TEXT AS reviewed_by, (SELECT journal_entry_id::TEXT FROM gl_journal_lines
        WHERE id = bt.matched_journal_line_id) AS je
    FROM bank_transactions bt WHERE id = ${bt}::UUID`) as Row[])[0]!;
}

/** Everything a refused call must leave as it was. */
export async function snapshot(c: Ctx, bt: string, rec: string) {
  const journals = Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries
    WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n);
  const docs = (await sql`SELECT id::TEXT AS id, status FROM supplier_payments WHERE company_id = ${c.fx.companyId}::UUID
    UNION ALL SELECT id::TEXT, status FROM customer_payments WHERE company_id = ${c.fx.companyId}::UUID ORDER BY 1`) as Row[];
  return { line: await lineRow(bt), rec: await recRow(rec), journals, docs };
}

/** Company-wide: posted debits equal posted credits. */
export async function trialBalanceGap(c: Ctx): Promise<number> {
  return Number(((await sql`SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS g FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${c.fx.companyId}::UUID AND e.status = 'posted'`) as Row[])[0]!.g);
}

/** AP control (credit-normal, posted) and the AP subledger (open bills less unapplied payment credit), company-wide. */
export async function apControlAndSubledger(c: Ctx): Promise<{ control: number; subledger: number }> {
  const control = Number(((await sql`SELECT COALESCE(SUM(l.credit - l.debit), 0)::float8 AS n FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.company_id = ${c.fx.companyId}::UUID AND e.status = 'posted' AND l.gl_account_id = ${c.acct.ap}::UUID`) as Row[])[0]!.n);
  const bills = Number(((await sql`SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0)::float8 AS n
    FROM supplier_invoices WHERE company_id = ${c.fx.companyId}::UUID AND status <> 'cancelled' AND gl_journal_entry_id IS NOT NULL`) as Row[])[0]!.n);
  const unapplied = Number(((await sql`SELECT COALESCE(SUM(p.total_amount - COALESCE((SELECT SUM(a.amount_allocated)
      FROM payment_allocations a WHERE a.payment_id = p.id), 0)), 0)::float8 AS n
    FROM supplier_payments p WHERE p.company_id = ${c.fx.companyId}::UUID AND p.status NOT IN ('cancelled', 'draft')
      AND p.gl_journal_entry_id IS NOT NULL`) as Row[])[0]!.n);
  return { control: Math.round(control * 100) / 100, subledger: Math.round((bills - unapplied) * 100) / 100 };
}

export async function entry(je: string) {
  return ((await sql`SELECT entry_date::TEXT AS d, reversed_at IS NOT NULL AS reversed, posting_agent, reversal_of_id::TEXT AS of
    FROM gl_journal_entries WHERE id = ${je}::UUID`) as Row[])[0]!;
}
