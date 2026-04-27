/**
 * Seed IsaDemo2 with a realistic mid-month bookkeeper's inbox state.
 *
 * Designed so an agent can walk a full monthly close end-to-end and uncover
 * real workflow issues. Idempotent — keyed off QA- prefixed external refs.
 *
 * Run with:
 *   bunx tsx scripts/seed-qa-bookkeeping.ts            # seed (skip existing)
 *   bunx tsx scripts/seed-qa-bookkeeping.ts --reset    # wipe QA records, reseed
 *
 * Requires: COMPANY_ID_ISADEMO2 in .env.local (set by provision-isademo2.ts).
 */

import { createSql, closeSql } from './_pg';
import { randomUUID } from 'crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const envPath = path.resolve('/home/hein/Workspace/IsaFlow/.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (!process.env[k!]) process.env[k!] = rawV!.replace(/^["']|["']$/g, '');
  }
}

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.MIGRATION_ADMIN_DATABASE_URL;
const COMPANY_ID = process.env.COMPANY_ID_ISADEMO2;

if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }
if (!COMPANY_ID)  { console.error('ERROR: COMPANY_ID_ISADEMO2 not set — run provision-isademo2.ts first'); process.exit(1); }

const sql = createSql(DATABASE_URL);
const RESET = process.argv.includes('--reset');

const today = new Date();
const yyyy = today.getFullYear();
const mm = today.getMonth() + 1;
const dd = today.getDate();
const isoToday = `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;

function daysAgo(n: number): string {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function getAdminUserId(): Promise<string> {
  const rows = await sql`
    SELECT user_id FROM company_users
    WHERE company_id = ${COMPANY_ID}::uuid
    ORDER BY (role = 'admin') DESC, created_at ASC
    LIMIT 1
  ` as Array<{ user_id: string }>;
  if (rows.length === 0) throw new Error('No users on IsaDemo2 — run provision-isademo2.ts');
  return rows[0]!.user_id;
}

const COA_TEMPLATE = [
  { code: '1000', name: 'Assets',                   type: 'asset',     normalBalance: 'debit',  level: 1, displayOrder: 100, isSystem: true },
  { code: '1100', name: 'Current Assets',           type: 'asset',     normalBalance: 'debit',  level: 2, displayOrder: 110, parentCode: '1000', isSystem: true },
  { code: '1110', name: 'Business Bank Account',    type: 'asset',     normalBalance: 'debit',  level: 3, displayOrder: 111, parentCode: '1100', subtype: 'bank', isSystem: true },
  { code: '1120', name: 'Accounts Receivable',      type: 'asset',     normalBalance: 'debit',  level: 3, displayOrder: 112, parentCode: '1100', subtype: 'receivable', isSystem: true },
  { code: '1140', name: 'VAT Input',                type: 'asset',     normalBalance: 'debit',  level: 3, displayOrder: 114, parentCode: '1100', subtype: 'vat_input', isSystem: true },
  { code: '2000', name: 'Liabilities',              type: 'liability', normalBalance: 'credit', level: 1, displayOrder: 200, isSystem: true },
  { code: '2100', name: 'Current Liabilities',      type: 'liability', normalBalance: 'credit', level: 2, displayOrder: 210, parentCode: '2000', isSystem: true },
  { code: '2110', name: 'Accounts Payable',         type: 'liability', normalBalance: 'credit', level: 3, displayOrder: 211, parentCode: '2100', subtype: 'payable', isSystem: true },
  { code: '2120', name: 'VAT Output',               type: 'liability', normalBalance: 'credit', level: 3, displayOrder: 212, parentCode: '2100', subtype: 'vat_output', isSystem: true },
  { code: '3000', name: 'Equity',                   type: 'equity',    normalBalance: 'credit', level: 1, displayOrder: 300, isSystem: true },
  { code: '3100', name: 'Share Capital',            type: 'equity',    normalBalance: 'credit', level: 2, displayOrder: 310, parentCode: '3000', subtype: 'equity', isSystem: true },
  { code: '3200', name: 'Retained Earnings',        type: 'equity',    normalBalance: 'credit', level: 2, displayOrder: 320, parentCode: '3000', subtype: 'retained_earnings', isSystem: true },
  { code: '4000', name: 'Revenue',                  type: 'revenue',   normalBalance: 'credit', level: 1, displayOrder: 400, isSystem: true },
  { code: '4100', name: 'Sales Revenue',            type: 'revenue',   normalBalance: 'credit', level: 2, displayOrder: 410, parentCode: '4000', subtype: 'default_revenue', isSystem: true },
  { code: '5000', name: 'Expenses',                 type: 'expense',   normalBalance: 'debit',  level: 1, displayOrder: 500, isSystem: true },
  { code: '5100', name: 'Cost of Sales',            type: 'expense',   normalBalance: 'debit',  level: 2, displayOrder: 510, parentCode: '5000', subtype: 'default_expense', isSystem: true },
  { code: '5500', name: 'Administrative',           type: 'expense',   normalBalance: 'debit',  level: 2, displayOrder: 560, parentCode: '5000', subtype: 'admin_expense', isSystem: true },
  { code: '5600', name: 'Bank Charges',             type: 'expense',   normalBalance: 'debit',  level: 2, displayOrder: 570, parentCode: '5000' },
] as const;

async function reset(): Promise<void> {
  console.log('[reset] Wiping QA records...');
  // Order: dependents first
  await sql`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = ${COMPANY_ID}::uuid)`;
  await sql`DELETE FROM customer_payments            WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM customer_invoice_items       WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ${COMPANY_ID}::uuid)`;
  await sql`DELETE FROM customer_invoices            WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM supplier_invoice_items       WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY_ID}::uuid)`;
  await sql`DELETE FROM supplier_invoices            WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM time_entries                 WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM practice_jobs                WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM practice_client_rate_overrides WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM practice_clients             WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM practice_work_items          WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM practice_job_categories      WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM practice_staff_rates         WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM bank_transactions            WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM bank_accounts                WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM customers                    WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM suppliers                    WHERE company_id = ${COMPANY_ID}::uuid`;
  await sql`DELETE FROM gl_accounts                  WHERE company_id = ${COMPANY_ID}::uuid`;
  console.log('[reset] Done.');
}

async function seedCOA(): Promise<Map<string, string>> {
  for (const acc of COA_TEMPLATE) {
    await sql`
      INSERT INTO gl_accounts (
        company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, level, display_order, is_system_account
      ) VALUES (
        ${COMPANY_ID}::uuid, ${acc.code}, ${acc.name}, ${acc.type},
        ${(acc as { subtype?: string }).subtype ?? null}, ${acc.normalBalance}, ${acc.level},
        ${acc.displayOrder}, ${(acc as { isSystem?: boolean }).isSystem ?? false}
      )
      ON CONFLICT (company_id, account_code) DO NOTHING
    `;
  }
  for (const acc of COA_TEMPLATE) {
    const parent = (acc as { parentCode?: string }).parentCode;
    if (!parent) continue;
    await sql`
      UPDATE gl_accounts
      SET parent_account_id = (SELECT id FROM gl_accounts WHERE company_id = ${COMPANY_ID}::uuid AND account_code = ${parent})
      WHERE company_id = ${COMPANY_ID}::uuid AND account_code = ${acc.code}
    `;
  }
  const rows = await sql`SELECT account_code, id FROM gl_accounts WHERE company_id = ${COMPANY_ID}::uuid` as Array<{ account_code: string; id: string }>;
  console.log(`[coa] ${rows.length} accounts`);
  return new Map(rows.map(r => [r.account_code, r.id]));
}

async function seedBankAccount(coa: Map<string, string>): Promise<string> {
  const glId = coa.get('1110')!;
  const existing = await sql`SELECT id FROM bank_accounts WHERE company_id = ${COMPANY_ID}::uuid AND account_number = 'QA-9000-0001' LIMIT 1` as Array<{ id: string }>;
  if (existing.length > 0) {
    console.log('[bank_account] exists');
    return existing[0]!.id;
  }
  const r = await sql`
    INSERT INTO bank_accounts (company_id, account_name, account_number, bank_name, account_type, gl_account_id, currency, is_active, opening_balance, current_balance)
    VALUES (${COMPANY_ID}::uuid, 'QA Primary Cheque', 'QA-9000-0001', 'FNB', 'cheque', ${glId}::uuid, 'ZAR', true, 250000, 250000)
    RETURNING id
  ` as Array<{ id: string }>;
  console.log('[bank_account] created');
  return r[0]!.id;
}

const QA_CUSTOMERS = [
  { code: 'QA-CUST-001', name: 'Acme Property Holdings (Pty) Ltd' },
  { code: 'QA-CUST-002', name: 'Northcliff Trading CC' },
  { code: 'QA-CUST-003', name: 'Sandton Logistics (Pty) Ltd' },
  { code: 'QA-CUST-004', name: 'Highveld Bricks (Pty) Ltd' },
  { code: 'QA-CUST-005', name: 'Brooklyn Coffee Roasters' },
];

async function seedCustomers(): Promise<Array<{ id: string; name: string; code: string }>> {
  const out: Array<{ id: string; name: string; code: string }> = [];
  for (const c of QA_CUSTOMERS) {
    const existing = await sql`SELECT id FROM customers WHERE company_id = ${COMPANY_ID}::uuid AND notes = ${c.code} LIMIT 1` as Array<{ id: string }>;
    if (existing.length > 0) {
      out.push({ id: existing[0]!.id, name: c.name, code: c.code });
      continue;
    }
    const r = await sql`
      INSERT INTO customers (company_id, name, email, payment_terms, is_active, notes, opening_balance)
      VALUES (${COMPANY_ID}::uuid, ${c.name}, ${`${c.code.toLowerCase()}@example.com`}, 30, true, ${c.code}, 0)
      RETURNING id
    ` as Array<{ id: string }>;
    out.push({ id: r[0]!.id, name: c.name, code: c.code });
  }
  console.log(`[customers] ${out.length}`);
  return out;
}

const QA_SUPPLIERS = [
  { code: 'QA-SUP-001', name: 'QA Office Supplies SA' },
  { code: 'QA-SUP-002', name: 'QA Telkom Connect' },
  { code: 'QA-SUP-003', name: 'QA Cleaning Co' },
  { code: 'QA-SUP-004', name: 'QA Couriers Direct' },
];

async function seedSuppliers(): Promise<Array<{ id: string; name: string; code: string }>> {
  const out: Array<{ id: string; name: string; code: string }> = [];
  for (const s of QA_SUPPLIERS) {
    const existing = await sql`SELECT id FROM suppliers WHERE company_id = ${COMPANY_ID}::uuid AND notes = ${s.code} LIMIT 1` as Array<{ id: string }>;
    if (existing.length > 0) {
      out.push({ id: existing[0]!.id, name: s.name, code: s.code });
      continue;
    }
    const r = await sql`
      INSERT INTO suppliers (company_id, name, email, payment_terms, is_active, notes)
      VALUES (${COMPANY_ID}::uuid, ${s.name}, ${`${s.code.toLowerCase()}@example.com`}, 30, true, ${s.code})
      RETURNING id
    ` as Array<{ id: string }>;
    out.push({ id: r[0]!.id, name: s.name, code: s.code });
  }
  console.log(`[suppliers] ${out.length}`);
  return out;
}

async function seedStaffRates(): Promise<void> {
  // Give every active UUID-shaped user on this tenant a rate. Some bootstrap
  // users (e.g. 'admin-001') aren't UUIDs and the practice_staff_rates.user_id
  // column is uuid-typed, so they're not addressable here.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const users = await sql`
    SELECT u.id FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    WHERE cu.company_id = ${COMPANY_ID}::UUID AND u.is_active = true
  ` as Array<{ id: string }>;

  let inserted = 0, skipped = 0;
  for (const u of users) {
    if (!UUID_RE.test(u.id)) { skipped++; continue; }
    const exists = await sql`SELECT 1 FROM practice_staff_rates WHERE company_id = ${COMPANY_ID}::uuid AND user_id = ${u.id}::uuid LIMIT 1` as Array<{ '?column?': number }>;
    if (exists.length > 0) continue;
    await sql`
      INSERT INTO practice_staff_rates (company_id, user_id, rate, currency, effective_from)
      VALUES (${COMPANY_ID}::uuid, ${u.id}::uuid, 650, 'ZAR', ${daysAgo(30)}::date)
    `;
    inserted++;
  }
  console.log(`[staff_rates] ${users.length} users (${inserted} new, ${skipped} non-UUID skipped) @ R650/hr`);
}

const CATEGORIES = [
  { name: 'Bookkeeping',        items: ['Transaction Capture', 'Bank Reconciliation', 'Month-end Review'] },
  { name: 'Monthly Accounting', items: ['Management Accounts', 'VAT Return Preparation'] },
  { name: 'Tax Returns',        items: ['Provisional Tax', 'Annual Income Tax'] },
  { name: 'Advisory',           items: ['Client Meeting', 'Ad-hoc Advisory'] },
];

async function seedCategoriesAndWorkItems(): Promise<Array<{ catId: string; itemId: string; catName: string; itemName: string }>> {
  const out: Array<{ catId: string; itemId: string; catName: string; itemName: string }> = [];
  for (let ci = 0; ci < CATEGORIES.length; ci++) {
    const cat = CATEGORIES[ci]!;
    let catRow = await sql`SELECT id FROM practice_job_categories WHERE company_id = ${COMPANY_ID}::uuid AND name = ${cat.name} LIMIT 1` as Array<{ id: string }>;
    if (catRow.length === 0) {
      catRow = await sql`
        INSERT INTO practice_job_categories (company_id, name, sort_order, is_active)
        VALUES (${COMPANY_ID}::uuid, ${cat.name}, ${ci * 10}, true)
        RETURNING id
      ` as Array<{ id: string }>;
    }
    const catId = catRow[0]!.id;

    for (let ii = 0; ii < cat.items.length; ii++) {
      const itemName = cat.items[ii]!;
      let itemRow = await sql`SELECT id FROM practice_work_items WHERE company_id = ${COMPANY_ID}::uuid AND category_id = ${catId}::uuid AND name = ${itemName} LIMIT 1` as Array<{ id: string }>;
      if (itemRow.length === 0) {
        itemRow = await sql`
          INSERT INTO practice_work_items (company_id, category_id, name, sort_order, is_active, default_billable)
          VALUES (${COMPANY_ID}::uuid, ${catId}::uuid, ${itemName}, ${ii * 10}, true, true)
          RETURNING id
        ` as Array<{ id: string }>;
      }
      out.push({ catId, itemId: itemRow[0]!.id, catName: cat.name, itemName });
    }
  }
  console.log(`[categories+work_items] ${CATEGORIES.length} categories, ${out.length} billable work items`);
  return out;
}

async function seedPracticeClients(customers: Array<{ id: string; name: string; code: string }>, adminId: string): Promise<Array<{ id: string; name: string; linkedCustomerId: string | null }>> {
  // Client 1: linked to customer #1 (full setup)
  // Client 2: linked to customer #2 (full setup)
  // Client 3: NO linked customer (deliberate WIP→invoice blocker test)
  const clients = [
    { name: 'QA Practice Client A', linked: customers[0]?.id ?? null, addRateOverride: true },
    { name: 'QA Practice Client B', linked: customers[1]?.id ?? null, addRateOverride: false },
    { name: 'QA Practice Client C (no customer link)', linked: null, addRateOverride: false },
  ];
  const out: Array<{ id: string; name: string; linkedCustomerId: string | null }> = [];

  for (const c of clients) {
    let row = await sql`SELECT id FROM practice_clients WHERE company_id = ${COMPANY_ID}::uuid AND legal_name = ${c.name} LIMIT 1` as Array<{ id: string }>;
    if (row.length === 0) {
      row = await sql`
        INSERT INTO practice_clients (company_id, legal_name, trading_name, billing_model, status, link_customer_id)
        VALUES (${COMPANY_ID}::uuid, ${c.name}, ${c.name}, 'hourly', 'active', ${c.linked ? `${c.linked}` : null}::uuid)
        RETURNING id
      ` as Array<{ id: string }>;
    }
    const clientId = row[0]!.id;
    out.push({ id: clientId, name: c.name, linkedCustomerId: c.linked });

    if (c.addRateOverride) {
      const exists = await sql`SELECT 1 FROM practice_client_rate_overrides WHERE company_id = ${COMPANY_ID}::uuid AND client_id = ${clientId}::uuid AND staff_user_id = ${adminId} LIMIT 1` as Array<{ '?column?': number }>;
      if (exists.length === 0) {
        await sql`
          INSERT INTO practice_client_rate_overrides (company_id, client_id, staff_user_id, rate_per_hour, effective_from)
          VALUES (${COMPANY_ID}::uuid, ${clientId}::uuid, ${adminId}, 850, ${daysAgo(15)}::date)
        `;
      }
    }
  }
  console.log(`[practice_clients] ${out.length} (1 with rate override, 1 with no linked customer)`);
  return out;
}

async function seedPracticeJob(client: { id: string; name: string }, categoryId: string, adminId: string): Promise<string> {
  const title = 'QA Monthly Bookkeeping (current month)';
  const existing = await sql`SELECT id FROM practice_jobs WHERE company_id = ${COMPANY_ID}::uuid AND practice_client_id = ${client.id}::uuid AND title = ${title} LIMIT 1` as Array<{ id: string }>;
  if (existing.length > 0) {
    console.log('[practice_jobs] exists');
    return existing[0]!.id;
  }
  const r = await sql`
    INSERT INTO practice_jobs (
      company_id, practice_client_id, job_category_id, title,
      partner_id, preparer_id, due_date, priority, status,
      financial_year, billing_type, budgeted_hours, created_by
    ) VALUES (
      ${COMPANY_ID}::uuid, ${client.id}::uuid, ${categoryId}::uuid, ${title},
      ${adminId}, ${adminId}, ${daysAgo(-7)}::date, 'high', 'in_progress',
      ${yyyy}, 'hourly', 6, ${adminId}
    )
    RETURNING id
  ` as Array<{ id: string }>;
  console.log(`[practice_jobs] created (6h budget, due in 7 days)`);
  return r[0]!.id;
}

async function seedTimeEntries(
  adminId: string,
  practiceClient: { id: string; name: string },
  jobId: string,
  workItems: Array<{ catId: string; itemId: string; catName: string; itemName: string }>,
): Promise<void> {
  const existing = await sql`SELECT COUNT(*)::int AS cnt FROM time_entries WHERE company_id = ${COMPANY_ID}::uuid AND notes LIKE 'QA-TE-%'` as Array<{ cnt: number }>;
  if ((existing[0]?.cnt ?? 0) >= 8) {
    console.log(`[time_entries] exists (${existing[0]!.cnt})`);
    return;
  }

  const bookkeepingItems = workItems.filter(w => w.catName === 'Bookkeeping');
  const advisoryItems = workItems.filter(w => w.catName === 'Advisory');

  // 8 entries this week — 6 billable, 2 non-billable, all unsubmitted (status: draft)
  const entries = [
    { day: 0, hrs: 1.5, item: bookkeepingItems[0], billable: true,  desc: 'Capture April bank txns' },
    { day: 0, hrs: 0.5, item: advisoryItems[0],   billable: false, desc: 'Internal team standup' },
    { day: 1, hrs: 2.0, item: bookkeepingItems[1], billable: true,  desc: 'Reconcile FNB cheque' },
    { day: 2, hrs: 1.0, item: bookkeepingItems[0], billable: true,  desc: 'Continue txn capture' },
    { day: 2, hrs: 1.5, item: bookkeepingItems[2], billable: true,  desc: 'Month-end review pass 1' },
    { day: 3, hrs: 0.75, item: advisoryItems[1],  billable: false, desc: 'Software training' },
    { day: 3, hrs: 1.25, item: bookkeepingItems[1], billable: true, desc: 'Bank rec adjustments' },
    { day: 4, hrs: 1.0, item: bookkeepingItems[2], billable: true,  desc: 'Sign-off review' },
  ];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (!e.item) continue;
    const tag = `QA-TE-${String(i + 1).padStart(3, '0')}`;
    const rate = e.billable ? 850 : 0;
    await sql`
      INSERT INTO time_entries (
        company_id, user_id, entry_date, hours, rate, billable, status,
        practice_client_id, job_category_id, work_item_id, applied_rate, line_total,
        task_description, notes, job_id, origin
      ) VALUES (
        ${COMPANY_ID}::uuid, ${adminId}, ${daysAgo(e.day)}::date, ${e.hrs}, ${rate}, ${e.billable}, 'draft',
        ${practiceClient.id}::uuid, ${e.item.catId}::uuid, ${e.item.itemId}::uuid, ${rate}, ${e.hrs * rate},
        ${e.desc}, ${tag}, ${jobId}::uuid, 'manual'
      )
    `;
  }
  console.log('[time_entries] 8 unsubmitted (6 billable @ R850, 2 non-billable)');
}

async function seedCustomerInvoices(coa: Map<string, string>, customers: Array<{ id: string; name: string; code: string }>, adminId: string): Promise<void> {
  const arGl = coa.get('1120')!;
  const revGl = coa.get('4100')!;
  const vatGl = coa.get('2120')!;

  const invoices = [
    { num: 'QA-INV-001', cust: 0, days: 5,  status: 'draft',    sub: 1500, paid: 0,    desc: 'April bookkeeping services' },
    { num: 'QA-INV-002', cust: 1, days: 12, status: 'draft',    sub: 2200, paid: 0,    desc: 'Monthly management accounts' },
    { num: 'QA-INV-003', cust: 0, days: 18, status: 'approved', sub: 4500, paid: 0,    desc: 'Quarterly VAT return' },
    { num: 'QA-INV-004', cust: 2, days: 32, status: 'approved', sub: 1800, paid: 0,    desc: 'Bank rec March' },
    { num: 'QA-INV-005', cust: 3, days: 45, status: 'approved', sub: 3200, paid: 1500, desc: 'Annual financial statements (partial)' },
    { num: 'QA-INV-006', cust: 4, days: 65, status: 'approved', sub: 950,  paid: 0,    desc: 'Tax provisional T1' },
    { num: 'QA-INV-007', cust: 1, days: 9,  status: 'approved', sub: 5400, paid: 0,    desc: 'Year-end review' },
    { num: 'QA-INV-008', cust: 2, days: 22, status: 'approved', sub: 750,  paid: 750,  desc: 'Ad-hoc advisory' },
  ];

  for (const inv of invoices) {
    const exists = await sql`SELECT id FROM customer_invoices WHERE company_id = ${COMPANY_ID}::uuid AND invoice_number = ${inv.num} LIMIT 1` as Array<{ id: string }>;
    if (exists.length > 0) continue;

    const cust = customers[inv.cust]!;
    const tax = Number((inv.sub * 0.15).toFixed(2));
    const total = Number((inv.sub + tax).toFixed(2));
    const invDate = daysAgo(inv.days);
    const dueDate = daysAgo(inv.days - 30);
    const invId = randomUUID();

    await sql`
      INSERT INTO customer_invoices (
        id, company_id, invoice_number, customer_id, subtotal, tax_rate, tax_amount, total_amount, amount_paid,
        status, invoice_date, due_date, notes, created_by, currency_code
      ) VALUES (
        ${invId}::uuid, ${COMPANY_ID}::uuid, ${inv.num}, ${cust.id}::uuid,
        ${inv.sub}, 15, ${tax}, ${total}, ${inv.paid},
        ${inv.status}, ${invDate}::date, ${dueDate}::date, ${inv.desc}, ${adminId}, 'ZAR'
      )
    `;
    await sql`
      INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, tax_rate, gl_account_id, currency_code)
      VALUES (${invId}::uuid, ${inv.desc}, 1, ${inv.sub}, ${inv.sub}, 15, ${revGl}::uuid, 'ZAR')
    `;
  }
  console.log(`[customer_invoices] 8 (3 draft, 5 approved — incl. 1 partial-paid, 1 fully-paid via amount_paid)`);
  void arGl; void vatGl;
}

async function seedSupplierInvoices(suppliers: Array<{ id: string; name: string; code: string }>, adminId: string): Promise<void> {
  const bills = [
    { num: 'QA-BILL-001', sup: 0, days: 8,  sub: 850,  desc: 'Office stationery — March' },
    { num: 'QA-BILL-002', sup: 1, days: 15, sub: 1450, desc: 'Internet + phone April' },
    { num: 'QA-BILL-003', sup: 2, days: 22, sub: 1200, desc: 'Office cleaning April' },
    { num: 'QA-BILL-004', sup: 3, days: 38, sub: 480,  desc: 'Courier deliveries March' },
  ];
  for (const b of bills) {
    const exists = await sql`SELECT id FROM supplier_invoices WHERE company_id = ${COMPANY_ID}::uuid AND invoice_number = ${b.num} LIMIT 1` as Array<{ id: string }>;
    if (exists.length > 0) continue;
    const sup = suppliers[b.sup]!;
    const tax = Number((b.sub * 0.15).toFixed(2));
    const total = Number((b.sub + tax).toFixed(2));
    await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid,
        status, currency, notes, created_by
      ) VALUES (
        ${COMPANY_ID}::uuid, ${b.num}, ${sup.id}::uuid, ${daysAgo(b.days)}::date, ${daysAgo(b.days - 30)}::date,
        ${b.sub}, 15, ${tax}, ${total}, 0,
        'approved', 'ZAR', ${b.desc}, ${adminId}
      )
    `;
  }
  console.log('[supplier_invoices] 4 unpaid');
}

async function seedBankTransactions(bankGlAccountId: string, customers: Array<{ id: string; name: string; code: string }>): Promise<void> {
  const existing = await sql`SELECT COUNT(*)::int AS cnt FROM bank_transactions WHERE company_id = ${COMPANY_ID}::uuid AND bank_reference LIKE 'QA-BT-%'` as Array<{ cnt: number }>;
  if ((existing[0]?.cnt ?? 0) >= 5) {
    console.log(`[bank_transactions] exists (${existing[0]!.cnt})`);
    return;
  }

  // 5 unallocated deposits — 3 should match invoices, 2 are unmatched
  const txns = [
    { ref: 'QA-BT-001', days: 3,  amt: 5175.00,  desc: `EFT ${customers[0]!.name} INV QA-INV-003` }, // matches QA-INV-003 total
    { ref: 'QA-BT-002', days: 6,  amt: 6210.00,  desc: `${customers[1]!.name} payment INV-007` },     // matches QA-INV-007 total
    { ref: 'QA-BT-003', days: 10, amt: 1092.50,  desc: `${customers[4]!.name} small payment` },       // matches QA-INV-006 total
    { ref: 'QA-BT-004', days: 14, amt: 12500.00, desc: 'EFT FROM UNKNOWN CLIENT' },                   // no match
    { ref: 'QA-BT-005', days: 18, amt: 875.00,   desc: 'BANK CHARGES MARCH' },                        // no match (debit-like)
  ];

  for (const t of txns) {
    await sql`
      INSERT INTO bank_transactions (bank_account_id, transaction_date, value_date, amount, description, reference, bank_reference, status, company_id)
      VALUES (${bankGlAccountId}::uuid, ${daysAgo(t.days)}::date, ${daysAgo(t.days)}::date, ${t.amt}, ${t.desc}, ${t.ref}, ${t.ref}, 'imported', ${COMPANY_ID}::uuid)
    `;
  }
  console.log('[bank_transactions] 5 unallocated (3 invoice-matchable, 2 unmatched)');
}

async function summarize(): Promise<void> {
  const counts = await sql`
    SELECT
      (SELECT count(*) FROM gl_accounts                  WHERE company_id = ${COMPANY_ID}::uuid)                    AS gl,
      (SELECT count(*) FROM bank_accounts                WHERE company_id = ${COMPANY_ID}::uuid)                    AS bank_accts,
      (SELECT count(*) FROM customers                    WHERE company_id = ${COMPANY_ID}::uuid)                    AS customers,
      (SELECT count(*) FROM suppliers                    WHERE company_id = ${COMPANY_ID}::uuid)                    AS suppliers,
      (SELECT count(*) FROM practice_clients             WHERE company_id = ${COMPANY_ID}::uuid)                    AS practice_clients,
      (SELECT count(*) FROM practice_job_categories      WHERE company_id = ${COMPANY_ID}::uuid)                    AS categories,
      (SELECT count(*) FROM practice_work_items          WHERE company_id = ${COMPANY_ID}::uuid)                    AS work_items,
      (SELECT count(*) FROM practice_jobs                WHERE company_id = ${COMPANY_ID}::uuid)                    AS jobs,
      (SELECT count(*) FROM time_entries                 WHERE company_id = ${COMPANY_ID}::uuid)                    AS time_entries,
      (SELECT count(*) FROM customer_invoices            WHERE company_id = ${COMPANY_ID}::uuid)                    AS cust_invoices,
      (SELECT count(*) FROM supplier_invoices            WHERE company_id = ${COMPANY_ID}::uuid)                    AS supp_invoices,
      (SELECT count(*) FROM bank_transactions            WHERE company_id = ${COMPANY_ID}::uuid)                    AS bank_txns
  ` as Array<Record<string, number>>;
  console.log('\n[summary]', counts[0]);
}

async function main(): Promise<void> {
  console.log(`Seeding QA bookkeeping cycle into IsaDemo2 (${COMPANY_ID})...`);
  if (RESET) await reset();

  const adminId = await getAdminUserId();
  console.log(`[admin_user] ${adminId}`);

  const coa       = await seedCOA();
  const bankAcct  = await seedBankAccount(coa);
  const customers = await seedCustomers();
  const suppliers = await seedSuppliers();

  await seedStaffRates();
  void adminId;
  const workItems = await seedCategoriesAndWorkItems();
  const practiceClients = await seedPracticeClients(customers, adminId);

  // Pick first client + first Bookkeeping category for the seed job
  const bookkeepingCatId = workItems.find(w => w.catName === 'Bookkeeping')!.catId;
  const jobId = await seedPracticeJob(practiceClients[0]!, bookkeepingCatId, adminId);
  await seedTimeEntries(adminId, practiceClients[0]!, jobId, workItems);

  await seedCustomerInvoices(coa, customers, adminId);
  await seedSupplierInvoices(suppliers, adminId);
  await seedBankTransactions(coa.get('1110')!, customers);
  void bankAcct;

  await summarize();
  console.log(`\nOK — IsaDemo2 seeded (today=${isoToday}).`);
  console.log('     next: bunx tsx scripts/qa-walkthrough.ts');
}

main()
  .then(() => closeSql())
  .catch(async (e) => { console.error(e); await closeSql(); process.exit(1); });
