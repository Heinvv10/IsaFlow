/**
 * ISAFlow Demo Data Seeder
 * Populates the demo company with realistic SA FTTH accounting data.
 * FY2025 (Mar 2024 - Feb 2025), FY2026 (Mar 2025 - Feb 2026), FY2027 (Mar 2026 - Mar 2027)
 *
 * Run with: npx tsx scripts/seed-demo-data.ts
 */

// Env vars must be set before running:
// export $(grep DATABASE_URL .env.local | xargs) && npx tsx scripts/seed-demo-data.ts
import { createSql } from './_pg';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('ERROR: DATABASE_URL not found in .env.local'); process.exit(1); }

const sql = createSql(DATABASE_URL);

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID   = 'a0000000-0000-0000-0000-000000000001';

const CUSTOMERS = [
  { id: 'c1000000-0000-0000-0000-000000000001', name: 'VelocityFibre (Pty) Ltd' },
  { id: 'c1000000-0000-0000-0000-000000000002', name: 'Metrofibre Networx' },
  { id: 'c1000000-0000-0000-0000-000000000003', name: 'Frogfoot Networks' },
  { id: 'c1000000-0000-0000-0000-000000000004', name: 'Vumatel Holdings' },
  { id: 'c1000000-0000-0000-0000-000000000005', name: 'Openserve (SOC)' },
  { id: 'c1000000-0000-0000-0000-000000000006', name: 'DFA (Dark Fibre Africa)' },
  { id: 'c1000000-0000-0000-0000-000000000007', name: 'LinkAfrica Telecoms' },
  { id: 'c1000000-0000-0000-0000-000000000008', name: 'Herotel (Pty) Ltd' },
];

type Supplier = { id: string; name: string; minAmt: number; maxAmt: number; expenseCode: string };
const SUPPLIERS: Supplier[] = [
  { id: 'd1000000-0000-0000-0000-000000000001', name: 'Makro SA',            minAmt: 10000, maxAmt: 80000, expenseCode: '5100' },
  { id: 'd1000000-0000-0000-0000-000000000002', name: 'Builders Warehouse',  minAmt:  5000, maxAmt: 30000, expenseCode: '5100' },
  { id: 'd1000000-0000-0000-0000-000000000003', name: 'Telkom SA',           minAmt:  8000, maxAmt: 15000, expenseCode: '5600' },
  { id: 'd1000000-0000-0000-0000-000000000004', name: 'Engen Petroleum',     minAmt: 12000, maxAmt: 25000, expenseCode: '5400' },
  { id: 'd1000000-0000-0000-0000-000000000005', name: 'Office National',     minAmt:  3000, maxAmt:  8000, expenseCode: '5600' },
  { id: 'd1000000-0000-0000-0000-000000000006', name: 'Vodacom Business',    minAmt:  5000, maxAmt: 12000, expenseCode: '5600' },
  { id: 'd1000000-0000-0000-0000-000000000007', name: 'City of JHB',         minAmt: 15000, maxAmt: 25000, expenseCode: '5600' },
  { id: 'd1000000-0000-0000-0000-000000000008', name: 'Sage SA',             minAmt:  2500, maxAmt:  5000, expenseCode: '5600' },
  { id: 'd1000000-0000-0000-0000-000000000009', name: 'Karabina Technologies',minAmt: 20000, maxAmt: 50000, expenseCode: '5200' },
  { id: 'd1000000-0000-0000-0000-000000000010', name: 'Bidvest Cleaning',    minAmt:  8000, maxAmt: 15000, expenseCode: '5600' },
];

// GL account IDs are resolved at runtime
type GlAccounts = Record<string, string>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function monthDate(year: number, month: number, day?: number): string {
  const d = day ?? randInt(1, 25);
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dueDate(invoiceDate: string, days: number): string {
  const d = new Date(invoiceDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0]!;
}

function vatCalc(subtotal: number): { subtotal: number; taxAmount: number; total: number } {
  const s = Math.round(subtotal * 100) / 100;
  const t = Math.round(s * 0.15 * 100) / 100;
  return { subtotal: s, taxAmount: t, total: s + t };
}

/** Growth factor: 15% YoY from FY2025 base. Seasonal: Dec/Jan -15% */
function growthFactor(year: number, month: number, baseYear = 2024): number {
  const yearsDiff = year - baseYear + (month >= 3 ? 0 : -1); // SA FY starts Mar
  const yoyFactor = Math.pow(1.15, Math.max(0, yearsDiff));
  const seasonal  = (month === 12 || month === 1) ? 0.85 : 1.0;
  return yoyFactor * seasonal;
}

/** Generate months from Mar 2024 to Mar 2027 inclusive */
function* monthRange(): Generator<{ year: number; month: number; label: string; idx: number }> {
  let idx = 0;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  for (let y = 2024; y <= 2027; y++) {
    const startM = y === 2024 ? 3 : 1;
    const endM   = y === 2027 ? 3 : 12;
    for (let m = startM; m <= endM; m++) {
      yield { year: y, month: m, label: `${months[m - 1]} ${y}`, idx: idx++ };
    }
  }
}

async function batchInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const BATCH = 40;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const keys = Object.keys(chunk[0]!);
    const valPlaceholders = chunk.map((_, ri) =>
      `(${keys.map((_, ki) => `$${ri * keys.length + ki + 1}`).join(', ')})`
    ).join(', ');
    const vals = chunk.flatMap(r => keys.map(k => r[k]));
    await sql.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES ${valPlaceholders} ON CONFLICT DO NOTHING`, vals);
  }
}

// ── Resolve GL accounts ───────────────────────────────────────────────────────

async function resolveGlAccounts(): Promise<GlAccounts> {
  const codes = ['1110','1120','1140','2110','2120','4100','4200','4300',
                 '5100','5200','5300','5400','5600','5700','5800','1230','3200'];
  const rows = await sql.query(
    `SELECT account_code, id FROM gl_accounts WHERE company_id = $1 AND account_code = ANY($2)`,
    [COMPANY_ID, codes]
  ) as { account_code: string; id: string }[];
  const map: GlAccounts = {};
  for (const r of rows) map[r.account_code] = r.id;
  return map;
}

// ── Ensure fiscal periods exist ───────────────────────────────────────────────

async function ensureFiscalPeriods(): Promise<void> {
  const monthNames = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
  const rows: Record<string, unknown>[] = [];
  for (let y = 2024; y <= 2027; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2027 && m > 3) break;
      const lastDay = new Date(y, m, 0).getDate();
      rows.push({
        period_name: `${monthNames[m - 1]} ${y}`,
        period_number: m,
        fiscal_year: y,
        start_date: `${y}-${String(m).padStart(2,'0')}-01`,
        end_date: `${y}-${String(m).padStart(2,'0')}-${lastDay}`,
        status: y < 2026 || (y === 2026 && m <= 2) ? 'closed' : 'open',
        company_id: COMPANY_ID,
      });
    }
  }
  await batchInsert('fiscal_periods', rows);
}

// ── CLEAN ─────────────────────────────────────────────────────────────────────

async function cleanExisting(): Promise<void> {
  console.log('[clean] Removing existing transaction data...');
  // Delete child rows first (FK-scoped via parent company_id)
  await sql.query(`DELETE FROM customer_payment_allocations WHERE payment_id IN (SELECT id FROM customer_payments WHERE company_id = $1)`, [COMPANY_ID]);
  await sql.query(`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = $1)`, [COMPANY_ID]);
  await sql.query(`DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = $1)`, [COMPANY_ID]);
  await sql.query(`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = $1)`, [COMPANY_ID]);
  await sql.query(`DELETE FROM customer_sales_order_items WHERE sales_order_id IN (SELECT id FROM customer_sales_orders WHERE company_id = $1)`, [COMPANY_ID]);
  await sql.query(`DELETE FROM supplier_purchase_order_items WHERE purchase_order_id IN (SELECT id FROM supplier_purchase_orders WHERE company_id = $1)`, [COMPANY_ID]);
  await sql.query(`DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)`, [COMPANY_ID]);

  // Delete parent tables with company_id
  const tables = [
    'customer_payments', 'supplier_payments',
    'customer_invoices', 'supplier_invoices',
    'credit_notes', 'gl_journal_entries',
    'bank_transactions',
    'customer_sales_orders', 'supplier_purchase_orders',
  ];
  for (const t of tables) {
    await sql.query(`DELETE FROM ${t} WHERE company_id = $1`, [COMPANY_ID]);
  }
  // gl_account_balances has no company_id — delete via gl_account scope
  await sql.query(`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)`, [COMPANY_ID]);
  await sql.query(`DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)`, [COMPANY_ID]);
  console.log('[clean] Done.\n');
}

// ── CUSTOMER INVOICES ─────────────────────────────────────────────────────────

async function seedCustomerInvoices(gl: GlAccounts): Promise<{ id: string; customerId: string; total: number; status: string; date: string }[]> {
  let invNum = 1;
  const invoices: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  const result: { id: string; customerId: string; total: number; status: string; date: string }[] = [];

  const lineDescs = [
    { desc: 'FTTH Installation - Drop & Splice', acct: '4100' },
    { desc: 'Aerial Fibre Deployment per km',    acct: '4100' },
    { desc: 'Monthly Maintenance & SLA',         acct: '4200' },
    { desc: 'CPE Hardware Supply & Config',      acct: '4100' },
    { desc: 'Duct & Civils Work',                acct: '4100' },
    { desc: 'Network Splicing & Testing',        acct: '4100' },
    { desc: 'Fibre Route Survey & Planning',     acct: '4200' },
  ];

  const TODAY = new Date();

  for (const { year, month, label, idx } of monthRange()) {
    const factor = growthFactor(year, month);
    const count = randInt(12, 18);

    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      const custIdx = (idx * count + i) % CUSTOMERS.length;
      const customer = CUSTOMERS[custIdx]!;
      const iDate = monthDate(year, month);

      // Large project invoice once per month
      const isLargeProject = i === 0 && Math.random() > 0.5;
      const baseSubtotal = isLargeProject
        ? rand(120000, 350000) * factor
        : rand(5000, 80000) * factor;

      const { subtotal, taxAmount, total } = vatCalc(baseSubtotal);

      // Status: older => mostly paid; recent => mix
      const monthsAgo = (TODAY.getFullYear() - year) * 12 + (TODAY.getMonth() + 1 - month);
      let status: string;
      if (monthsAgo > 6)       status = 'paid';
      else if (monthsAgo > 3)  status = pick(['paid','paid','paid','partially_paid']);
      else if (monthsAgo > 1)  status = pick(['paid','sent','partially_paid','overdue']);
      else                     status = pick(['sent','draft','approved','overdue']);

      const amountPaid = status === 'paid' ? total
        : status === 'partially_paid' ? Math.round(total * rand(0.3, 0.7) * 100) / 100
        : 0;

      const invNumber = `INV-${String(invNum++).padStart(5, '0')}`;

      invoices.push({
        id, company_id: COMPANY_ID,
        invoice_number: invNumber,
        customer_id: customer.id,
        client_id: customer.id,
        invoice_date: iDate,
        due_date: dueDate(iDate, 30),
        subtotal, tax_rate: 15.00, tax_amount: taxAmount, total_amount: total,
        amount_paid: amountPaid,
        status, notes: isLargeProject ? `Major project - ${label}` : `${label} services`,
        created_by: ADMIN_ID,
      });

      result.push({ id, customerId: customer.id, total, status, date: iDate });

      // 1-4 line items per invoice
      const lineCount = randInt(1, 4);
      let lineRunning = 0;
      for (let li = 0; li < lineCount; li++) {
        const line = pick(lineDescs);
        const lineSubtotal = li === lineCount - 1 ? subtotal - lineRunning : Math.round(subtotal / lineCount * 100) / 100;
        lineRunning += lineSubtotal < 0 ? 0 : lineSubtotal;
        items.push({
          id: randomUUID(),
          invoice_id: id,
          description: line.desc,
          quantity: randInt(1, 10),
          unit_price: Math.round((lineSubtotal / randInt(1, 10)) * 100) / 100,
          amount: Math.max(0, lineSubtotal),
          tax_rate: 15.00,
          gl_account_id: gl[line.acct] ?? null,
        });
      }
    }
  }

  await batchInsert('customer_invoices', invoices);
  await batchInsert('customer_invoice_items', items);
  console.log(`[invoices] Seeded ${invoices.length} customer invoices, ${items.length} line items.`);
  return result;
}

// ── CUSTOMER PAYMENTS ─────────────────────────────────────────────────────────

async function seedCustomerPayments(gl: GlAccounts, invoices: { id: string; customerId: string; total: number; status: string; date: string }[]): Promise<void> {
  const payments: Record<string, unknown>[] = [];
  const allocations: Record<string, unknown>[] = [];
  const methods = ['eft','eft','eft','eft','eft','eft','eft','card','card','cash'];

  for (const inv of invoices) {
    if (inv.status !== 'paid' && inv.status !== 'partially_paid') continue;
    const pId = randomUUID();
    const pDate = dueDate(inv.date, randInt(5, 25));
    const pAmount = inv.status === 'paid' ? inv.total
      : Math.round(inv.total * rand(0.3, 0.7) * 100) / 100;

    payments.push({
      id: pId, company_id: COMPANY_ID,
      client_id: inv.customerId,
      payment_date: pDate,
      total_amount: pAmount,
      payment_method: pick(methods),
      bank_account_id: gl['1110'] ?? null,
      description: `Payment for ${inv.id.slice(0, 8)}`,
      status: 'confirmed',
      created_by: ADMIN_ID,
    });

    allocations.push({
      id: randomUUID(),
      payment_id: pId,
      invoice_id: inv.id,
      amount_allocated: pAmount,
    });
  }

  await batchInsert('customer_payments', payments);
  await batchInsert('customer_payment_allocations', allocations);
  console.log(`[payments] Seeded ${payments.length} customer payments.`);
}

// ── CUSTOMER QUOTES ───────────────────────────────────────────────────────────

async function seedCustomerQuotes(gl: GlAccounts): Promise<void> {
  let quoteNum = 1;
  const quotes: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];

  for (const { year, month } of monthRange()) {
    const count = randInt(4, 7);
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      const customer = pick(CUSTOMERS)!;
      const qDate = monthDate(year, month);
      const { subtotal, taxAmount, total } = vatCalc(rand(15000, 200000) * growthFactor(year, month));
      const status = pick(['draft','sent','accepted','accepted','rejected','expired','converted']);
      const expiryDays = randInt(14, 60);

      quotes.push({
        id, company_id: COMPANY_ID,
        quote_number: `QUO-${String(quoteNum++).padStart(5, '0')}`,
        client_id: customer.id,
        quote_date: qDate,
        expiry_date: dueDate(qDate, expiryDays),
        status,
        subtotal, tax_rate: 15.00, tax_amount: taxAmount, total,
        notes: `Quote for ${customer.name} - ${year}/${String(month).padStart(2,'0')}`,
        created_by: ADMIN_ID,
      });

      lines.push({
        id: randomUUID(), quote_id: id,
        description: pick(['FTTH Infrastructure Deployment','Fibre Backbone Installation',
                           'Network Maintenance Contract','CPE Hardware Supply',
                           'Route Survey & Engineering']),
        quantity: randInt(1, 5),
        unit_price: Math.round(subtotal / randInt(1, 5) * 100) / 100,
        amount: subtotal,
        tax_rate: 15.00,
        gl_account_id: gl['4100'] ?? null,
        sort_order: 0,
      });
    }
  }

  // customer_quotes table doesn't exist — skip
  console.log(`[quotes] Skipped ${quotes.length} quotes (table not created yet).`);
}

// ── SUPPLIER INVOICES ─────────────────────────────────────────────────────────

async function seedSupplierInvoices(gl: GlAccounts): Promise<{ id: string; supplierId: string; total: number; status: string; date: string }[]> {
  let invNum = 1;
  const invoices: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  const result: { id: string; supplierId: string; total: number; status: string; date: string }[] = [];

  const TODAY = new Date();

  for (const { year, month, idx } of monthRange()) {
    const factor = growthFactor(year, month);
    const count = randInt(12, 18);

    for (let i = 0; i < count; i++) {
      const supplier = SUPPLIERS[((idx * count + i) % SUPPLIERS.length)]!;
      const id = randomUUID();
      const iDate = monthDate(year, month);
      const baseSubtotal = rand(supplier.minAmt, supplier.maxAmt) * factor;
      const { subtotal, taxAmount, total } = vatCalc(baseSubtotal);

      const monthsAgo = (TODAY.getFullYear() - year) * 12 + (TODAY.getMonth() + 1 - month);
      let status: string;
      if (monthsAgo > 6)       status = 'paid';
      else if (monthsAgo > 3)  status = pick(['paid','paid','paid','partially_paid']);
      else if (monthsAgo > 1)  status = pick(['paid','approved','partially_paid']);
      else                     status = pick(['approved','draft','partially_paid']);

      const amountPaid = status === 'paid' ? total
        : status === 'partially_paid' ? Math.round(total * rand(0.3, 0.7) * 100) / 100
        : 0;

      invoices.push({
        id, company_id: COMPANY_ID,
        invoice_number: `SINV-${String(invNum++).padStart(5, '0')}`,
        supplier_id: supplier.id,
        invoice_date: iDate,
        due_date: dueDate(iDate, 30),
        subtotal, tax_rate: 15.00, tax_amount: taxAmount, total_amount: total,
        amount_paid: amountPaid,
        payment_terms: 'net30',
        status,
        notes: `${supplier.name} invoice ${year}/${String(month).padStart(2,'0')}`,
        created_by: ADMIN_ID,
      });

      result.push({ id, supplierId: supplier.id, total, status, date: iDate });

      items.push({
        id: randomUUID(),
        supplier_invoice_id: id,
        description: `Goods/Services - ${supplier.name}`,
        quantity: 1,
        unit_price: subtotal,
        tax_rate: 15.00,
        tax_amount: taxAmount,
        line_total: total,
        gl_account_id: gl[supplier.expenseCode] ?? null,
      });
    }
  }

  await batchInsert('supplier_invoices', invoices);
  await batchInsert('supplier_invoice_items', items);
  console.log(`[sup-invoices] Seeded ${invoices.length} supplier invoices.`);
  return result;
}

// ── SUPPLIER PAYMENTS ─────────────────────────────────────────────────────────

async function seedSupplierPayments(gl: GlAccounts, invoices: { id: string; supplierId: string; total: number; status: string; date: string }[]): Promise<void> {
  const payments: Record<string, unknown>[] = [];
  const allocations: Record<string, unknown>[] = [];

  for (const inv of invoices) {
    if (inv.status !== 'paid' && inv.status !== 'partially_paid') continue;
    const pId = randomUUID();
    const pDate = dueDate(inv.date, randInt(5, 30));
    const pAmount = inv.status === 'paid' ? inv.total
      : Math.round(inv.total * rand(0.3, 0.7) * 100) / 100;

    payments.push({
      id: pId, company_id: COMPANY_ID,
      supplier_id: inv.supplierId,
      payment_date: pDate,
      total_amount: pAmount,
      payment_method: 'eft',
      bank_account_id: gl['1110'] ?? null,
      description: `Payment to supplier ${inv.supplierId.slice(0, 8)}`,
      status: 'processed',
      created_by: ADMIN_ID,
    });

    allocations.push({
      id: randomUUID(),
      payment_id: pId,
      invoice_id: inv.id,
      amount_allocated: pAmount,
    });
  }

  await batchInsert('supplier_payments', payments);
  await batchInsert('payment_allocations', allocations);
  console.log(`[sup-payments] Seeded ${payments.length} supplier payments.`);
}

// ── CREDIT NOTES ──────────────────────────────────────────────────────────────

async function seedCreditNotes(
  custInvoices: { id: string; customerId: string; total: number; status: string; date: string }[],
  supInvoices: { id: string; supplierId: string; total: number; status: string; date: string }[]
): Promise<void> {
  const notes: Record<string, unknown>[] = [];
  let cnNum = 1;

  for (const { year, month } of monthRange()) {
    // 1 customer credit note per month
    const custInv = pick(custInvoices.filter(i => i.status === 'paid'));
    if (custInv) {
      const creditAmt = Math.round(custInv.total * rand(0.1, 0.25) * 100) / 100;
      const { subtotal: s, taxAmount: t, total: tot } = vatCalc(creditAmt / 1.15);
      notes.push({
        id: randomUUID(), company_id: COMPANY_ID,
        credit_note_number: `CRN-${String(cnNum++).padStart(5,'0')}`,
        type: 'customer',
        client_id: custInv.customerId,
        customer_invoice_id: custInv.id,
        credit_date: monthDate(year, month),
        reason: pick(['Service quality adjustment','Billing error correction','Return credit']),
        subtotal: s, tax_rate: 15.00, tax_amount: t, total_amount: tot,
        status: 'applied',
        created_by: ADMIN_ID,
      });
    }

    // 1 supplier credit note per month
    const supInv = pick(supInvoices.filter(i => i.status === 'paid'));
    if (supInv) {
      const creditAmt = Math.round(supInv.total * rand(0.05, 0.2) * 100) / 100;
      const { subtotal: s, taxAmount: t, total: tot } = vatCalc(creditAmt / 1.15);
      notes.push({
        id: randomUUID(), company_id: COMPANY_ID,
        credit_note_number: `CRN-${String(cnNum++).padStart(5,'0')}`,
        type: 'supplier',
        supplier_id: supInv.supplierId,
        supplier_invoice_id: supInv.id,
        credit_date: monthDate(year, month),
        reason: pick(['Faulty goods return','Overcharge correction','Quantity dispute']),
        subtotal: s, tax_rate: 15.00, tax_amount: t, total_amount: tot,
        status: 'applied',
        created_by: ADMIN_ID,
      });
    }
  }

  await batchInsert('credit_notes', notes);
  console.log(`[credit-notes] Seeded ${notes.length} credit notes.`);
}

// ── GL JOURNAL ENTRIES ────────────────────────────────────────────────────────

async function seedJournalEntries(gl: GlAccounts): Promise<void> {
  const entries: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];

  const journalTypes = [
    {
      desc: 'Monthly Depreciation',
      lines: (amt: number) => [
        { acct: '5800', debit: amt, credit: 0 },
        { acct: '1230', debit: 0,   credit: amt },
      ],
      amtRange: [3500, 8500] as [number, number],
    },
    {
      desc: 'Salary Accrual',
      lines: (amt: number) => [
        { acct: '5200', debit: amt, credit: 0 },
        { acct: '2110', debit: 0,   credit: amt },
      ],
      amtRange: [75000, 120000] as [number, number],
    },
    {
      desc: 'Prepaid Expense Adjustment',
      lines: (amt: number) => [
        { acct: '5600', debit: amt, credit: 0 },
        { acct: '1110', debit: 0,   credit: amt },
      ],
      amtRange: [2000, 8000] as [number, number],
    },
    {
      desc: 'Bank Charges',
      lines: (amt: number) => [
        { acct: '5700', debit: amt, credit: 0 },
        { acct: '1110', debit: 0,   credit: amt },
      ],
      amtRange: [250, 1500] as [number, number],
    },
    {
      desc: 'Interest Income',
      lines: (amt: number) => [
        { acct: '1110', debit: amt, credit: 0 },
        { acct: '4300', debit: 0,   credit: amt },
      ],
      amtRange: [500, 2500] as [number, number],
    },
  ];

  for (const { year, month } of monthRange()) {
    for (let i = 0; i < 5; i++) {
      const jType = journalTypes[i % journalTypes.length]!;
      const amt = Math.round(rand(...jType.amtRange) * 100) / 100;
      const jeId = randomUUID();
      const eDate = monthDate(year, month, randInt(1, 28));

      entries.push({
        id: jeId, company_id: COMPANY_ID,
        entry_date: eDate,
        description: `${jType.desc} - ${year}/${String(month).padStart(2,'0')}`,
        source: 'manual',
        status: 'posted',
        created_by: ADMIN_ID,
        posted_by: ADMIN_ID,
      });

      for (const l of jType.lines(amt)) {
        if (!gl[l.acct]) continue;
        lines.push({
          id: randomUUID(),
          journal_entry_id: jeId,
          gl_account_id: gl[l.acct],
          debit: l.debit,
          credit: l.credit,
          description: jType.desc,
        });
      }
    }
  }

  await batchInsert('gl_journal_entries', entries);
  await batchInsert('gl_journal_lines', lines);
  console.log(`[journals] Seeded ${entries.length} journal entries, ${lines.length} lines.`);
}

// ── BANK TRANSACTIONS ─────────────────────────────────────────────────────────

async function seedBankTransactions(
  gl: GlAccounts,
  custPayments: { id: string; customerId: string; total: number; status: string; date: string }[],
  supPayments: { id: string; supplierId: string; total: number; status: string; date: string }[]
): Promise<void> {
  const transactions: Record<string, unknown>[] = [];
  const bankAcctId = gl['1110'];
  if (!bankAcctId) { console.log('[bank] No bank account found, skipping.'); return; }

  const TODAY = new Date();

  for (const { year, month } of monthRange()) {
    const batchId = randomUUID();
    const monthsAgo = (TODAY.getFullYear() - year) * 12 + (TODAY.getMonth() + 1 - month);
    const txStatus = monthsAgo > 3 ? 'reconciled' : monthsAgo > 0 ? 'matched' : 'imported';

    // Customer inflows (10-15 per month)
    for (let i = 0; i < randInt(10, 15); i++) {
      const factor = growthFactor(year, month);
      transactions.push({
        id: randomUUID(), company_id: COMPANY_ID,
        bank_account_id: bankAcctId,
        transaction_date: monthDate(year, month),
        amount: Math.round(rand(20000, 180000) * factor * 100) / 100,
        description: `EFT REC ${pick(CUSTOMERS)!.name.toUpperCase().slice(0, 20)}`,
        reference: `CR-${year}${String(month).padStart(2,'0')}-${String(i + 1).padStart(3,'0')}`,
        status: txStatus,
        import_batch_id: batchId,
      });
    }

    // Supplier outflows (8-12 per month)
    for (let i = 0; i < randInt(8, 12); i++) {
      const sup = pick(SUPPLIERS)!;
      const factor = growthFactor(year, month);
      transactions.push({
        id: randomUUID(), company_id: COMPANY_ID,
        bank_account_id: bankAcctId,
        transaction_date: monthDate(year, month),
        amount: -Math.round(rand(sup.minAmt, sup.maxAmt) * factor * 100) / 100,
        description: `EFT PMT ${sup.name.toUpperCase().slice(0, 20)}`,
        reference: `DR-${year}${String(month).padStart(2,'0')}-${String(i + 1).padStart(3,'0')}`,
        status: txStatus,
        import_batch_id: batchId,
      });
    }

    // Recurring: bank charges, salary, interest
    transactions.push(
      { id: randomUUID(), company_id: COMPANY_ID, bank_account_id: bankAcctId,
        transaction_date: monthDate(year, month, 28),
        amount: -Math.round(rand(300, 800) * 100) / 100,
        description: `BANK CHARGES ${year}/${String(month).padStart(2,'0')}`,
        status: txStatus, import_batch_id: batchId },
      { id: randomUUID(), company_id: COMPANY_ID, bank_account_id: bankAcctId,
        transaction_date: monthDate(year, month, 25),
        amount: -Math.round(rand(80000, 130000) * growthFactor(year, month) * 100) / 100,
        description: `SALARY PAYMENT ${year}/${String(month).padStart(2,'0')}`,
        reference: `PAYROLL-${year}${String(month).padStart(2,'0')}`,
        status: txStatus, import_batch_id: batchId },
      { id: randomUUID(), company_id: COMPANY_ID, bank_account_id: bankAcctId,
        transaction_date: monthDate(year, month, 28),
        amount: Math.round(rand(500, 2500) * 100) / 100,
        description: `CREDIT INTEREST ${year}/${String(month).padStart(2,'0')}`,
        status: txStatus, import_batch_id: batchId }
    );
  }

  // Suppress unused param warnings - these were for future use
  void custPayments; void supPayments;

  await batchInsert('bank_transactions', transactions);
  console.log(`[bank] Seeded ${transactions.length} bank transactions.`);
}

// ── PURCHASE ORDERS ───────────────────────────────────────────────────────────

async function seedPurchaseOrders(): Promise<void> {
  const orders: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  let poNum = 1;

  for (const { year, month } of monthRange()) {
    const count = randInt(4, 7);
    for (let i = 0; i < count; i++) {
      const sup = pick(SUPPLIERS)!;
      const id = randomUUID();
      const oDate = monthDate(year, month);
      const { subtotal, taxAmount, total } = vatCalc(rand(sup.minAmt, sup.maxAmt) * growthFactor(year, month));
      const status = pick(['draft','sent','received','received','invoiced','invoiced']);

      orders.push({
        id, company_id: COMPANY_ID,
        order_number: `PO-${String(poNum++).padStart(5,'0')}`,
        supplier_id: sup.id,
        order_date: oDate,
        delivery_date: dueDate(oDate, randInt(7, 21)),
        subtotal, tax_rate: 15.00, tax_amount: taxAmount, total_amount: total,
        status,
        notes: `Purchase order to ${sup.name}`,
        created_by: ADMIN_ID,
      });

      items.push({
        id: randomUUID(), purchase_order_id: id,
        description: `Goods & services from ${sup.name}`,
        quantity: randInt(1, 20),
        unit_price: Math.round(subtotal / randInt(1, 20) * 100) / 100,
        tax_rate: 15.00,
        tax_amount: taxAmount,
        line_total: total,
      });
    }
  }

  await batchInsert('supplier_purchase_orders', orders);
  await batchInsert('supplier_purchase_order_items', items);
  console.log(`[purchase-orders] Seeded ${orders.length} POs.`);
}

// ── SALES ORDERS ──────────────────────────────────────────────────────────────

async function seedSalesOrders(): Promise<void> {
  const orders: Record<string, unknown>[] = [];
  const items: Record<string, unknown>[] = [];
  let soNum = 1;

  for (const { year, month } of monthRange()) {
    const count = randInt(4, 7);
    for (let i = 0; i < count; i++) {
      const customer = pick(CUSTOMERS)!;
      const id = randomUUID();
      const oDate = monthDate(year, month);
      const { subtotal, taxAmount, total } = vatCalc(rand(20000, 200000) * growthFactor(year, month));
      const status = pick(['confirmed','confirmed','invoiced','invoiced','partially_invoiced']);

      orders.push({
        id, company_id: COMPANY_ID,
        order_number: `SO-${String(soNum++).padStart(5,'0')}`,
        customer_id: customer.id,
        order_date: oDate,
        delivery_date: dueDate(oDate, randInt(7, 30)),
        subtotal, tax_rate: 15.00, tax_amount: taxAmount, total_amount: total,
        status,
        notes: `Sales order for ${customer.name}`,
        created_by: ADMIN_ID,
      });

      items.push({
        id: randomUUID(), sales_order_id: id,
        description: pick(['FTTH Infrastructure Deployment','Fibre Maintenance Contract',
                           'CPE Hardware Supply','Network Engineering Services']),
        quantity: randInt(1, 10),
        unit_price: Math.round(subtotal / randInt(1, 10) * 100) / 100,
        tax_rate: 15.00,
        tax_amount: taxAmount,
        line_total: total,
      });
    }
  }

  await batchInsert('customer_sales_orders', orders);
  await batchInsert('customer_sales_order_items', items);
  console.log(`[sales-orders] Seeded ${orders.length} SOs.`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== ISAFlow Demo Data Seeder ===');
  console.log(`Company: ${COMPANY_ID}`);
  console.log('Range:   March 2024 → March 2027\n');

  const gl = await resolveGlAccounts();
  const missing = ['1110','4100','4200','5100','5200','5600','5700','5800','1230'].filter(c => !gl[c]);
  if (missing.length > 0) {
    console.error(`ERROR: Missing GL accounts: ${missing.join(', ')}`);
    console.error('Run all migrations first.');
    process.exit(1);
  }

  await cleanExisting();
  await ensureFiscalPeriods();

  const custInvoices = await seedCustomerInvoices(gl);
  await seedCustomerPayments(gl, custInvoices);
  await seedCustomerQuotes(gl);

  const supInvoices = await seedSupplierInvoices(gl);
  await seedSupplierPayments(gl, supInvoices);

  await seedCreditNotes(custInvoices, supInvoices);
  await seedJournalEntries(gl);

  const custPaid = custInvoices.filter(i => i.status === 'paid' || i.status === 'partially_paid');
  const supPaid  = supInvoices.filter(i => i.status === 'paid' || i.status === 'partially_paid');
  await seedBankTransactions(gl, custPaid, supPaid);

  await seedPurchaseOrders();
  await seedSalesOrders();

  console.log('\n=== Seeding complete! ===');
  const totalMonths = [...monthRange()].length;
  console.log(`Covered ${totalMonths} months across FY2025, FY2026, FY2027.`);

  // Summary counts
  const [ciCount] = await sql.query(`SELECT COUNT(*) AS c FROM customer_invoices WHERE company_id = $1`, [COMPANY_ID]) as { c: string }[];
  const [siCount] = await sql.query(`SELECT COUNT(*) AS c FROM supplier_invoices WHERE company_id = $1`, [COMPANY_ID]) as { c: string }[];
  const [btCount] = await sql.query(`SELECT COUNT(*) AS c FROM bank_transactions WHERE company_id = $1`, [COMPANY_ID]) as { c: string }[];
  console.log(`Customer invoices : ${ciCount?.c ?? 0}`);
  console.log(`Supplier invoices : ${siCount?.c ?? 0}`);
  console.log(`Bank transactions : ${btCount?.c ?? 0}`);

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('Seeder error:', err);
  process.exit(1);
});
