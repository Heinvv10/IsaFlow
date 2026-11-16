/**
 * Fixture for tests/integration/demo-reseed.int.test.ts: a Demo company dirtied
 * the way production's is (real names, QA artefacts, far-future rows, an
 * unlinked reconciled bank line, append-only SARS rows), a second tenant with a
 * row in every family the reseed touches, and per-company table checksums.
 * Everything runs on one client inside one outer transaction the test rolls back.
 */

import type pg from 'pg';

export const DEMO = '00000000-0000-0000-0000-000000000001';
export const OTHER = '7e5d0000-0000-4000-8000-0000000000aa';
const ACTOR = 'a0000000-0000-0000-0000-000000000001';

type Q = (text: string, values?: unknown[]) => Promise<Array<Record<string, unknown>>>;
export const q = (c: pg.Client): Q => async (text, values = []) => (await c.query(text, values)).rows as Array<Record<string, unknown>>;

async function acct(c: pg.Client, company: string, code: string): Promise<string> {
  const [r] = await q(c)('SELECT id FROM gl_accounts WHERE company_id = $1 AND account_code = $2', [company, code]);
  return String(r!.id);
}

async function period(c: pg.Client, company: string, day: string): Promise<void> {
  await q(c)('SELECT fiscal_periods_generate(fiscal_year_ensure($1::uuid, $2::date))', [company, day]);
}

/** The Demo company (created if this database has none) and the second tenant, each with the default chart. */
export async function companies(c: pg.Client): Promise<void> {
  // The services the gate reaches write audit_log rows naming their user (FK to users).
  await q(c)(`INSERT INTO users (id, email) VALUES ($1, 'reseed-actor@example.co.za') ON CONFLICT (id) DO NOTHING`, [ACTOR]);
  await q(c)(`INSERT INTO companies (id, name, is_demo) VALUES ($1, 'ISAFlow Demo (Pty) Ltd', true)
              ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_demo = true`, [DEMO]);
  const [n] = await q(c)('SELECT count(*)::int AS n FROM gl_accounts WHERE company_id = $1', [DEMO]);
  if (Number(n!.n) === 0) await q(c)('SELECT seed_company_default_taxonomy($1)', [DEMO]);
  // The owner the reseed records as author; the import exemption's rank check needs a membership.
  await q(c)(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [DEMO, ACTOR]);
  await q(c)(`INSERT INTO companies (id, name) VALUES ($1, 'Other Tenant (Pty) Ltd')`, [OTHER]);
  await q(c)('SELECT seed_company_default_taxonomy($1)', [OTHER]);
}

/** A posted, balanced two-line journal (Dr bank / Cr sales) and its bank line. */
async function journal(c: pg.Client, company: string, day: string, amount: string, text: string): Promise<string> {
  await period(c, company, day);
  const bank = await acct(c, company, '1110');
  const [je] = await q(c)(`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, posted_by, posted_at, created_by)
    VALUES ($1, $2, $3, 'manual', 'posted', $4, now(), $4) RETURNING id`, [company, day, text, ACTOR]);
  await q(c)(`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, description)
    VALUES ($1, $2, $3, $4, 0, $5), ($1, $2, $6, 0, $4, $5)`, [je!.id, company, bank, amount, text, await acct(c, company, '4100')]);
  return String(je!.id);
}

/** One row in each family the reseed wipes and seeds, for either company. */
export async function rowsFor(c: pg.Client, company: string, tag: string, opts: { invoiceDay: string; journalDay: string; runYear: number }): Promise<void> {
  const x = q(c);
  const [cu] = await x(`INSERT INTO customers (company_id, name) VALUES ($1, $2) RETURNING id`, [company, `${tag} Customer`]);
  const [su] = await x(`INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [company, `${tag} Supplier`]);
  const [ci] = await x(`INSERT INTO customer_invoices (company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_amount, total_amount, status, created_by)
    VALUES ($1, $2, $3, $3, $4, $4::date + 30, 100, 15, 115, 'sent', $5) RETURNING id`, [company, `${tag}-INV-1`, cu!.id, opts.invoiceDay, ACTOR]);
  await x(`INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES ($1, 'Work', 1, 100, 100)`, [ci!.id]);
  const [si] = await x(`INSERT INTO supplier_invoices (company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_amount, total_amount, status, created_by)
    VALUES ($1, $2, $3, $4, 100, 15, 115, 'draft', $5) RETURNING id`, [company, `${tag}-BILL-1`, su!.id, opts.invoiceDay, ACTOR]);
  await x(`INSERT INTO supplier_invoice_items (supplier_invoice_id, description, quantity, unit_price, line_total) VALUES ($1, 'Stock', 1, 100, 100)`, [si!.id]);
  await journal(c, company, opts.journalDay, '250.00', `${tag} journal`);
  await x(`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES ($1, $2, $3, 250, $4, $5)`, [company, await acct(c, company, '1110'), opts.journalDay, `${tag} bank line`,
    company === DEMO ? 'reconciled' : 'imported']);
  const [emp] = await x(`INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date)
    VALUES ($1, $2, $3, 'Person', '2020-01-01') RETURNING id`, [company, `${tag}-E1`, tag]);
  const [run] = await x(`INSERT INTO payroll_run_headers (company_id, period_year, period_month, status, created_by)
    VALUES ($1, $2, 1, 'draft', $3) RETURNING id`, [company, opts.runYear, ACTOR]);
  await x(`INSERT INTO payroll_run_lines (run_id, employee_id, gross_pay, net_pay) VALUES ($1, $2, 1000, 900)`, [run!.id, emp!.id]);
  await x(`INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years)
    VALUES ($1, $2, $3, '2025-01-15', 5000, 3)`, [company, `${tag}-A1`, `${tag} Asset`]);
  await x(`INSERT INTO practice_clients (company_id, legal_name) VALUES ($1, $2)`, [company, `${tag} Practice Client`]);
  await x(`INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, title)
    VALUES ($1, $2, $3, '2025-06-01', $4)`, [company, emp!.id, `${tag}-CL-1`, `${tag} claim`]);
}

/** The production Demo's problems, in miniature (PLAN 8.2). */
export async function dirtyDemo(c: pg.Client): Promise<{ costCentre: string; budget: string; trv: string; submission: string }> {
  const x = q(c);
  await rowsFor(c, DEMO, 'Vumatel Holdings', { invoiceDay: '2027-03-23', journalDay: '2031-01-31', runYear: 2031 });
  for (const n of ['Eskom Holdings SOC Ltd', '[MERGED] Eskom Holdings', '0GP-Golden-Supplier']) await x('INSERT INTO suppliers (company_id, name) VALUES ($1, $2)', [DEMO, n]);
  const [cust] = await x(`INSERT INTO customers (company_id, name) VALUES ($1, '0GP-Golden-Customer') RETURNING id`, [DEMO]);
  await x(`INSERT INTO customer_contacts (company_id, customer_id, full_name) VALUES ($1, $2, 'Golden Contact')`, [DEMO, cust!.id]);
  await x(`INSERT INTO assets (company_id, asset_number, name, purchase_date, purchase_price, useful_life_years)
    VALUES ($1, '0GP-1', '0GP-Golden-Asset', '2026-01-10', 1000, 3)`, [DEMO]);
  const [emp] = await x(`SELECT id FROM payroll_employees WHERE company_id = $1 LIMIT 1`, [DEMO]);
  await x(`INSERT INTO expense_claims (company_id, employee_id, claim_number, claim_date, title, description)
    VALUES ($1, $2, 'QA-1', '2026-01-05', 'QA demo claim', 'QA demo claim'), ($1, $2, 'QA-2', '2026-01-06', 'Phase 10 e2e retest', NULL)`, [DEMO, emp!.id]);
  await x(`INSERT INTO practice_clients (company_id, legal_name) VALUES ($1, 'DEMO UX Practice Client')`, [DEMO]);
  await x(`INSERT INTO imap_mirror_connections (company_id, provider, display_name, account_email) VALUES ($1, 'imap', 'QA Demo Mailbox', 'qa@example.co.za'),
    ($1, 'imap', 'Accounts inbox', 'accounts@example.co.za')`, [DEMO]);
  const [cc] = await x(`INSERT INTO cost_centres (company_id, code, name) VALUES ($1, 'OPS', 'Operations') RETURNING id`, [DEMO]);
  const [bv] = await x(`INSERT INTO budget_versions (company_id, fiscal_year, name, kind, created_by) VALUES ($1, 2027, 'FY2027 budget', 'original', 'qa') RETURNING id`, [DEMO]);
  const [ss] = await x(`INSERT INTO sars_submissions (company_id, form_type, period_start, period_end, status) VALUES ($1, 'EMP201', '2025-01-01', '2025-01-31', 'submitted') RETURNING id`, [DEMO]);
  const [trv] = await x(`INSERT INTO tax_return_versions (company_id, form_type, period_start, period_end, version_no, figures, posted_through, finalised_by, sars_submission_id)
    VALUES ($1, 'EMP201', '2025-01-01', '2025-01-31', 1, '{}'::jsonb, now(), 'qa', $2) RETURNING id`, [DEMO, ss!.id]);
  return { costCentre: String(cc!.id), budget: String(bv!.id), trv: String(trv!.id), submission: String(ss!.id) };
}

/** count and md5 of every public table with a company_id for one company, plus the child tables reached through it. */
export async function checksums(c: pg.Client, company: string): Promise<Record<string, string>> {
  const tables = (await q(c)(`SELECT c.table_name AS t FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'company_id' ORDER BY 1`)).map((r) => String(r.t));
  const children: Array<[string, string]> = [
    ['customer_invoice_items', 'invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)'],
    ['supplier_invoice_items', 'supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1)'],
    ['customer_payment_allocations', 'payment_id IN (SELECT id FROM customer_payments WHERE company_id = $1)'],
    ['payment_allocations', 'payment_id IN (SELECT id FROM supplier_payments WHERE company_id = $1)'],
    ['payroll_run_lines', 'run_id IN (SELECT id FROM payroll_run_headers WHERE company_id = $1)'],
    ['gl_account_balances', 'gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)'],
  ];
  const out: Record<string, string> = {};
  for (const [t, where] of [...tables.map((t) => [t, 'company_id = $1'] as [string, string]), ...children]) {
    const [r] = await q(c)(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS s FROM ${t} x WHERE ${where}`, [company]);
    out[t] = String(r!.s);
  }
  return out;
}

/** Tables whose checksum differs between two snapshots. */
export function changed(a: Record<string, string>, b: Record<string, string>): string[] {
  return Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);
}
