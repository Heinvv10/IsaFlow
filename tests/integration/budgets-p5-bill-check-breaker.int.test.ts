/**
 * Budgets P5-2, the breaker's repros for PR #1103 (adversarial review), kept as regressions:
 *   1. a bill evidenced by a bank-first provisional: approving reclasses the provisional's expense
 *      away, so the check must count the bill's lines LESS the reclass (else R800 is read twice);
 *   2. two bills on ONE PO line: the dry run must count the line's commitment once, as the live run does;
 *   3. a bill linked to a PO line on ANOTHER account: the commitment it releases there must reach
 *      the later bill's check in the dry run, as it does live.
 * Real PostgreSQL as app_user. Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { billState, dropBillFixture, makeBill, openRequest, seedBillFixture, setPolicy, type BillFixture } from './helpers/budgetBillFixture';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let f: BillFixture;
const uid = () => crypto.randomUUID();

beforeAll(async () => { f = await seedBillFixture(pool, 'breaker'); }, 60_000);
afterAll(async () => {
  try { await dropBillFixture(pool, f); } finally { await pool.end(); }
}, 60_000);

async function committed<T>(fn: () => Promise<T>): Promise<T> {
  const r = await openRequest(pool, f, f.owner);
  try {
    const out = await r.run(fn);
    await r.commit();
    return out;
  } finally {
    await r.rollback();
  }
}
const ctx = (): McpToolContext => ({ companyId: f.co, userId: f.owner, companyRole: 'owner', scopes: ['write:invoices', 'write:post'], tokenJti: 'jti-brk', oauthAppId: null });
const text = (res: { content: Array<{ text: string }> }) => res.content[0]!.text;

async function po(month: string, lines: Array<{ acct: string; amount: number; cc1?: string | null }>): Promise<string[]> {
  const poId = uid();
  await pool.query(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status) VALUES ($1, $2, $3, $4, $5, 'approved')`,
    [poId, f.co, `PO-${poId.slice(0, 6)}`, f.supplier, `${month}-02`]);
  const ids: string[] = [];
  for (const l of lines) {
    const id = uid();
    await pool.query(`INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, line_total, gl_account_id, cc1_id)
                      VALUES ($1, $2, 'po', 1, $3, $3, $4, $5)`, [id, poId, l.amount, l.acct, l.cc1 ?? null]);
    ids.push(id);
  }
  return ids;
}
const linkToPo = (bill: string, poItem: string) =>
  pool.query('UPDATE supplier_invoice_items SET po_item_id = $2 WHERE supplier_invoice_id = $1', [bill, poItem]);
/** Two ids in a known order (the live loop posts sorted by id). */
const ordered = (): [string, string] => [uid(), uid()].sort() as [string, string];

/** A posted, evidenced bank-first provisional (DR opex FT 800, DR VAT 120, CR bank 920) and the bill raised from its slip. */
async function provisionalAndBill(month: string): Promise<string> {
  const bank = uid();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
                    VALUES ($1, $2, $3, 'Bank', 'asset', 'bank', 'debit', 3, true)`, [bank, f.co, `BB-1${bank.slice(0, 4)}`]);
  const doc = uid();
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
  const je = uid();
  await pool.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, source_document_id, needs_evidence, created_by)
                    VALUES ($1, $2, $3, $4, 'Bank-first provisional', 'posted', 'auto_bank_recon', $5, false, $6)`,
  [je, f.co, `JE-BRK-${je.slice(0, 6)}`, `${month}-10`, doc, f.owner]);
  for (const [acct, dr, cr, cc] of [[f.acc.opex, 800, 0, f.cc.FT], [f.acc.vat, 120, 0, null], [bank, 0, 920, null]] as const) {
    await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description, cc1_id)
                      VALUES ($1, $2, $3, $4, $5, 'prov', $6)`, [je, f.co, acct, dr, cr, cc]);
  }
  await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, status, provisional_je_id, description)
                    VALUES ($1, $2, $3, -920, 'matched', $4, 'card')`, [f.co, bank, `${month}-10`, je]);
  const bill = await makeBill(pool, f, [{ acct: f.acc.opex, amount: 800, cc1: f.cc.FT }], { date: `${month}-10` });
  await pool.query('UPDATE supplier_invoices SET source_document_id = $2 WHERE id = $1', [bill, doc]);
  return bill;
}
const opexFtSpend = async (month: string) => Number((await pool.query(
  `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::TEXT AS s FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = $1 AND je.status = 'posted' AND jl.gl_account_id = $2 AND jl.cc1_id = $3 AND to_char(je.entry_date, 'YYYY-MM') = $4`,
  [f.co, f.acc.opex, f.cc.FT, month])).rows[0].s);
const uiApprove = (bill: string) => committed(() => approveSupplierInvoice(f.co, bill, f.owner, {
  budget: { channel: 'ui', lock: 'take', reason: null, override: false, actorRole: 'manager' },
})).then(() => 'approved', (e: unknown) => (e as Error).message);

describe('a bank-first provisional is counted once', () => {
  it('control (policy off): approving claims the provisional and the month nets to R800 of opex FT spend', async () => {
    await setPolicy(pool, f, 'off');
    const bill = await provisionalAndBill('2026-11');
    expect(await uiApprove(bill)).toBe('approved');
    expect(await opexFtSpend('2026-11')).toBe(800); // the slip expensed ONCE: R800 against a R1 000 budget
  });

  it('block: the same bill is approved (R800 actual, + R800 bill − R800 reclass)', async () => {
    await setPolicy(pool, f, 'block');
    const bill = await provisionalAndBill('2026-10');
    expect(await uiApprove(bill)).toBe('approved');
  });
});

describe('MCP bulk dry run agrees with the live run on PO-linked bills', () => {
  it('two bills on ONE PO line: the dry run refuses the second, as the live run does', async () => {
    await setPolicy(pool, f, 'block');
    const [poItem] = await po('2026-08', [{ acct: f.acc.opex, amount: 1000, cc1: f.cc.FT }]);
    const [a, b] = ordered();
    await makeBill(pool, f, [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }], { date: '2026-08-15', id: a });
    await makeBill(pool, f, [{ acct: f.acc.opex, amount: 600, cc1: f.cc.FT }], { date: '2026-08-15', id: b });
    await linkToPo(a, poItem!);
    await linkToPo(b, poItem!);
    const dry = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [a, b], dry_run: true, idempotency_key: `d-${a}` }, ctx()))));
    const live = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [a, b], idempotency_key: `l-${a}` }, ctx()))));
    const liveIds = (live.invoices ?? []).map((r: { id: string }) => r.id).sort();
    expect({ dry: [...dry.would_post_ids].sort(), live: liveIds }).toEqual({ dry: liveIds, live: liveIds });
  });

  it('a bill linked to a PO line on ANOTHER account: the dry run posts the later bill, as the live run does', async () => {
    await setPolicy(pool, f, 'block');
    // Travel (company grain) R500 in 2026-09, fully committed by a PO line.
    const [poItem] = await po('2026-09', [{ acct: f.acc.travel, amount: 500 }]);
    const [a, c] = ordered();
    // A posts to opex FT but is linked to the travel PO line: approving it releases R100 of travel commitment.
    await makeBill(pool, f, [{ acct: f.acc.opex, amount: 100, cc1: f.cc.FT }], { date: '2026-09-15', id: a });
    await linkToPo(a, poItem!);
    await makeBill(pool, f, [{ acct: f.acc.travel, amount: 100 }], { date: '2026-09-15', id: c });
    const dry = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [a, c], dry_run: true, idempotency_key: `d-${a}` }, ctx()))));
    const live = JSON.parse(text(await committed(() => bulkApproveSupplierInvoicesTool.handler(
      { invoice_ids: [a, c], idempotency_key: `l-${a}` }, ctx()))));
    const liveIds = (live.invoices ?? []).map((r: { id: string }) => r.id).sort();
    expect({ dry: [...dry.would_post_ids].sort(), live: liveIds }).toEqual({ dry: liveIds, live: liveIds });
    expect((await billState(pool, c)).status).toBeDefined();
  });
});
