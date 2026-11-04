/**
 * Budgets P5-2 (the budget check at bill approval), real PostgreSQL. One company per suite:
 * an owner and a manager, a payable / VAT input / default-expense chart plus three expense
 * accounts, two CC1 centres, the FY2027 registry year (Mar 2026 - Feb 2027) and its PRIMARY
 * budget (approved):
 *   - opex  BB-6100 at CC1: FT 1 000 a month, HT 0 a month (a deliberate zero budget);
 *   - travel BB-6200 at company level: 500 a month;
 *   - nob   BB-6300: no budget at all.
 * Bills are dated 2026-06-15 (month 2026-06), net storage, 15% VAT on top. Seeded as the
 * superuser; every request runs as app_user under forced RLS (withAuth or `openRequest`).
 * Disposable databases only (assertDisposable).
 */
import { Pool, type PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { request, response } from '../mfa-impersonation-postgres.helpers';

const id = (): string => crypto.randomUUID();
export const BILL_DATE = '2026-06-15';
export const MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10',
  '2026-11', '2026-12', '2027-01', '2027-02'];

export interface BillFixture {
  co: string; owner: string; manager: string; supplier: string; version: string;
  acc: Record<'ap' | 'vat' | 'defExp' | 'opex' | 'travel' | 'nob', string>;
  cc: Record<'FT' | 'HT', string>;
}

export async function seedBillFixture(pool: Pool, tag: string): Promise<BillFixture> {
  const f: BillFixture = {
    co: id(), owner: id(), manager: id(), supplier: id(), version: '',
    acc: { ap: id(), vat: id(), defExp: id(), opex: id(), travel: id(), nob: id() },
    cc: { FT: id(), HT: id() },
  };
  await pool.query('INSERT INTO companies (id, name, financial_year_start) VALUES ($1, $2, 3)', [f.co, `P5-2 ${tag}`]);
  await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true), ($3, $4, 'admin', true)",
    [f.owner, `${f.owner}@test.local`, f.manager, `${f.manager}@test.local`]);
  await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'manager')",
    [f.co, f.owner, f.manager]);
  for (const [aid, code, name, type, sub, normal, sys] of [
    [f.acc.ap, 'BB-2100', 'AP', 'liability', 'payable', 'credit', true],
    [f.acc.vat, 'BB-1400', 'VAT input', 'asset', 'vat_input', 'debit', true],
    [f.acc.defExp, 'BB-6000', 'Sundry', 'expense', 'default_expense', 'debit', true],
    [f.acc.opex, 'BB-6100', 'Opex', 'expense', null, 'debit', false],
    [f.acc.travel, 'BB-6200', 'Travel', 'expense', null, 'debit', false],
    [f.acc.nob, 'BB-6300', 'Unbudgeted', 'expense', null, 'debit', false],
  ] as const) {
    await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype,
                        normal_balance, level, is_active, is_system_account) VALUES ($1, $2, $3, $4, $5, $6, $7, 3, true, $8)`,
    [aid, f.co, code, name, type, sub, normal, sys]);
  }
  await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type) VALUES ($1, $3, 'FT', 'Fibertime', 'cc1'),
                      ($2, $3, 'HT', 'Hometech', 'cc1')`, [f.cc.FT, f.cc.HT, f.co]);
  await pool.query("INSERT INTO suppliers (id, company_id, name, is_active) VALUES ($1, $2, 'P5-2 Supplies', true)", [f.supplier, f.co]);
  await pool.query(`INSERT INTO fiscal_years (company_id, fiscal_year, start_date, end_date, kind)
                    VALUES ($1, 2027, '2026-03-01', '2027-02-28', 'normal')`, [f.co]);
  f.version = String((await pool.query(
    `INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
     VALUES ($1, 2027, 'Original', 'original', true, $2) RETURNING id`, [f.co, f.owner])).rows[0].id);
  await pool.query(`UPDATE budget_versions SET status = 'approved', approved_by = $2, approved_at = clock_timestamp() WHERE id = $1`,
    [f.version, f.owner]);
  const amounts = (acct: string, amount: number, cc1: string | null) => pool.query(
    `INSERT INTO budget_month_amounts (company_id, version_id, gl_account_id, month, amount, cc1_id)
     SELECT $1, $2, $3, (m || '-01')::DATE, $4, $5 FROM unnest($6::TEXT[]) AS m`, [f.co, f.version, acct, amount, cc1, MONTHS]);
  await amounts(f.acc.opex, 1000, f.cc.FT);
  await amounts(f.acc.opex, 0, f.cc.HT);
  await amounts(f.acc.travel, 500, null);
  clearSystemAccountCache(f.co);
  return f;
}

export async function setPolicy(pool: Pool, f: BillFixture, policy: 'off' | 'warn' | 'block'): Promise<void> {
  await pool.query(`INSERT INTO budget_control_settings (company_id, check_policy) VALUES ($1, $2)
                    ON CONFLICT (company_id) DO UPDATE SET check_policy = EXCLUDED.check_policy`, [f.co, policy]);
}

export interface BillLine { acct: string; amount: number; cc1?: string | null }

/** A bill (net storage) committed as the superuser. */
export async function makeBill(
  pool: Pool, f: BillFixture, lines: BillLine[], opts: { status?: string; date?: string; id?: string } = {},
): Promise<string> {
  const status = opts.status ?? 'draft';
  const bid = opts.id ?? id();
  const net = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const vat = Math.round(net * 15) / 100;
  await pool.query(
    `INSERT INTO supplier_invoices (id, company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount,
       total_amount, created_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, 15, $7, $8, $9, $10)`,
    [bid, f.co, `P52-${bid.slice(0, 8)}`, f.supplier, opts.date ?? BILL_DATE, net, vat, Math.round((net + vat) * 100) / 100, f.owner, status]);
  for (const l of lines) {
    await pool.query(
      `INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total,
         gl_account_id, cc1_id) VALUES ($1, 'P5-2 line', 1, $2, 15, $3, $2, $4, $5)`,
      [bid, l.amount, Math.round(l.amount * 15) / 100, l.acct, l.cc1 ?? null]);
  }
  return bid;
}

/** A request transaction as withAuth binds it (app_user, the user's claims, the company GUC). Caller commits or rolls back. */
export async function openRequest(pool: Pool, f: BillFixture, user: string) {
  const client: PoolClient = await pool.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [f.co]);
  const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  let done = false;
  const end = async (sqlText: string) => {
    if (done) return;
    done = true;
    try { await client.query(sqlText); } finally { client.release(); }
  };
  return {
    client, pid,
    run: <T>(fn: () => Promise<T>): Promise<T> => als.run({ client, companyId: f.co, userId: user, claims: { sub: user } } as never, fn),
    commit: () => end('COMMIT'),
    rollback: () => end('ROLLBACK'),
  };
}

const tokens = new Map<string, string>();
async function tokenFor(user: string): Promise<string> {
  if (!tokens.has(user)) {
    tokens.set(user, await new SignJWT({ sub: user, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET)));
  }
  return tokens.get(user)!;
}

type Route = (req: never, res: never) => unknown;
/** POSTs `body` to a route through withAuth, as `user` of the fixture's company. */
export async function callRoute(route: Route, f: BillFixture, user: string, url: string, body: unknown) {
  const req = request({ 'sb-access-token': await tokenFor(user), active_company_id: f.co }, 'POST');
  req.url = url;
  req.body = body;
  const result = response();
  await route(req as never, result.res as never);
  return result.state as { statusCode: number; body: { data?: unknown; error?: { message?: string; details?: Record<string, unknown> } } & Record<string, unknown> };
}

export async function billState(pool: Pool, billId: string) {
  const r = (await pool.query(
    `SELECT status, gl_journal_entry_id, amount_paid::TEXT AS amount_paid, notes,
            (SELECT count(*)::INT FROM gl_journal_entries WHERE company_id = si.company_id) AS journals
       FROM supplier_invoices si WHERE id = $1`, [billId])).rows[0];
  return r as { status: string; gl_journal_entry_id: string | null; amount_paid: string; notes: string | null; journals: number };
}

export async function eventsFor(pool: Pool, billId: string) {
  return (await pool.query(
    `SELECT outcome, policy, channel, reason, decided_by, lines FROM budget_check_events WHERE document_id = $1 ORDER BY decided_at`,
    [billId])).rows as Array<{ outcome: string; policy: string; channel: string; reason: string | null; decided_by: string; lines: Array<Record<string, unknown>> }>;
}

export async function auditFor(pool: Pool, billId: string) {
  return (await pool.query(
    `SELECT action, user_id, changes FROM audit_log WHERE entity_type = 'budget' AND entity_id = $1 ORDER BY created_at`, [billId])).rows as
    Array<{ action: string; user_id: string; changes: { metadata?: Record<string, string> } }>;
}

export async function dropBillFixture(pool: Pool, f: BillFixture | undefined): Promise<void> {
  if (!f) return;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1)', [f.co]);
    await c.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [f.co]);
    await c.query('DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = $1)', [f.co]);
    await c.query('DELETE FROM po_items WHERE purchase_order_id IN (SELECT id FROM purchase_orders WHERE company_id = $1)', [f.co]);
    for (const t of ['budget_check_events', 'audit_log', 'mcp_tool_calls', 'supplier_payments', 'bank_transactions', 'purchase_orders', 'vat_period_locks',
      'recurring_transaction_templates', 'company_document_numbers', 'capture_events', 'captured_documents',
      'supplier_invoices', 'gl_journal_lines', 'gl_journal_entries',
      'budget_month_amounts', 'budget_versions', 'budget_control_settings', 'fiscal_periods', 'fiscal_years', 'suppliers', 'cost_centres',
      'gl_accounts', 'company_users']) {
      await c.query(`DELETE FROM ${t} WHERE company_id = $1`, [f.co]);
    }
    await c.query('DELETE FROM companies WHERE id = $1', [f.co]);
    await c.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[f.owner, f.manager]]);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

/** An approved PO dated `${month}-02` with one line per entry; returns the PO line ids. */
export async function seedPo(pool: Pool, f: BillFixture, month: string, lines: Array<{ acct: string; amount: number; cc1?: string | null }>): Promise<string[]> {
  const poId = id();
  await pool.query(`INSERT INTO purchase_orders (id, company_id, po_number, supplier_id, order_date, status) VALUES ($1, $2, $3, $4, $5, 'approved')`,
    [poId, f.co, `PO-${poId.slice(0, 6)}`, f.supplier, `${month}-02`]);
  const ids: string[] = [];
  for (const l of lines) {
    const itemId = id();
    await pool.query(`INSERT INTO po_items (id, purchase_order_id, description, quantity, unit_price, line_total, gl_account_id, cc1_id)
                      VALUES ($1, $2, 'po', 1, $3, $3, $4, $5)`, [itemId, poId, l.amount, l.acct, l.cc1 ?? null]);
    ids.push(itemId);
  }
  return ids;
}

export const linkBillToPo = (pool: Pool, bill: string, poItem: string) =>
  pool.query('UPDATE supplier_invoice_items SET po_item_id = $2 WHERE supplier_invoice_id = $1', [bill, poItem]);

/**
 * A posted, evidenced bank-first provisional dated `provDate` (DR opex FT 800, DR VAT 120, CR bank 920) and its
 * captured slip; the caller raises bills from the slip with `fromSlip`.
 */
export async function seedProvisional(pool: Pool, f: BillFixture, provDate: string): Promise<string> {
  const bank = id();
  await pool.query(`INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, level, is_active)
                    VALUES ($1, $2, $3, 'Bank', 'asset', 'bank', 'debit', 3, true)`, [bank, f.co, `BB-1${bank.slice(0, 4)}`]);
  const doc = id();
  await pool.query(`INSERT INTO captured_documents (id, company_id, file_name, file_type) VALUES ($1, $2, 'slip.pdf', 'application/pdf')`, [doc, f.co]);
  const je = id();
  await pool.query(`INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description, status, source, source_document_id, needs_evidence, created_by)
                    VALUES ($1, $2, $3, $4, 'Bank-first provisional', 'posted', 'auto_bank_recon', $5, false, $6)`,
  [je, f.co, `JE-PRV-${je.slice(0, 6)}`, provDate, doc, f.owner]);
  for (const [acct, dr, cr, cc, vat] of [[f.acc.opex, 800, 0, f.cc.FT, null], [f.acc.vat, 120, 0, null, 'standard'], [bank, 0, 920, null, null]] as const) {
    await pool.query(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description, cc1_id, vat_type)
                      VALUES ($1, $2, $3, $4, $5, 'prov', $6, $7)`, [je, f.co, acct, dr, cr, cc, vat]);
  }
  await pool.query(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, status, provisional_je_id, description)
                    VALUES ($1, $2, $3, -920, 'matched', $4, 'card')`, [f.co, bank, provDate, je]);
  return doc;
}

export const fromSlip = (pool: Pool, bill: string, doc: string) =>
  pool.query('UPDATE supplier_invoices SET source_document_id = $2 WHERE id = $1', [bill, doc]);

/** Files the VAT period [start, end] for the fixture's company (vat_period_locks), as a filed VAT201 leaves it. */
export async function fileVatPeriod(pool: Pool, f: BillFixture, start: string, end: string): Promise<void> {
  await pool.query(`INSERT INTO vat_period_locks (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by, actor_type)
                    VALUES ($1, $2, $3, 0, 0, 0, NOW(), $4, 'human')`, [f.co, start, end, f.owner]);
}
