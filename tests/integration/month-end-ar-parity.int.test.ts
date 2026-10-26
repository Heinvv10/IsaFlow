// tests/integration/month-end-ar-parity.int.test.ts
//
// The Month-End "Sales & Receivables" card must show the same overdue figure as
// the invoice-list tile (getAROutstandingSummary). It used to age receivables
// as at the period's last day, so for an open month every invoice due between
// today and month end counted as overdue (dev Demo: R 3 680.00 above the tile).
// The fixture carries exactly that invoice, plus the card's formatting.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { getMonthEndWorkbench } from '@/modules/accounting/services/workbench/monthEndWorkbenchService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAROutstandingSummary } from '@/modules/accounting/services/ar/arOutstandingService';
import { fmtDate } from '@/lib/fmtDate';
import { formatMoney } from '@/lib/money/formatMoney';

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = '00000000-0000-0000-0000-00000000e2a1';
const CUSTOMER = '00000000-0000-0000-0000-00000000e2a2';
const SUPPLIER = '00000000-0000-0000-0000-00000000e2a4';
const BANK = '00000000-0000-0000-0000-00000000e2a3';

const OVERDUE_BAL = 1000;   // due 10 days ago: overdue today and at any later date
const DUE_SOON_BAL = 250;   // due in 3 days: NOT overdue today, overdue as at next month's end
const FUTURE_BAL = 400;     // due in 90 days: overdue at neither date
const OLD_BAL = 70;         // due 95 days ago: overdue at every date since

const AP_OVERDUE = 500;     // due 10 days ago
const AP_DUE_SOON = 200;    // due in 3 days: not overdue today
const AP_OLD = 30;          // due 95 days ago

const describeIfDb = DATABASE_URL ? describe : describe.skip;

function addDays(base: Date, days: number): string {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

describeIfDb('month-end Sales card agrees with the shared AR aggregate', () => {
  let admin: Pool;
  const now = new Date();
  // Next month: its last day is always after today, so the period is open.
  const periodDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const period = `${periodDate.getFullYear()}-${String(periodDate.getMonth() + 1).padStart(2, '0')}`;
  const periodEnd = fmtDate(new Date(periodDate.getFullYear(), periodDate.getMonth() + 1, 0));

  beforeAll(async () => {
    assertNotProductionDb('This test inserts and deletes invoice fixtures.');
    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanup(admin);
    await admin.query(`INSERT INTO companies (id, name, is_active) VALUES ($1,'Month End Parity Fixture',true)`, [COMPANY]);
    await admin.query(`INSERT INTO customers (id, company_id, name) VALUES ($1,$2,'ME Customer')`, [CUSTOMER, COMPANY]);
    await admin.query(`INSERT INTO suppliers (id, company_id, name) VALUES ($1,$2,'ME Supplier')`, [SUPPLIER, COMPANY]);
    await admin.query(
      `INSERT INTO gl_accounts (id, company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active)
       VALUES ($1,$2,'ME1000','Bank','asset','bank','debit',true)`, [BANK, COMPANY]);
    await insertInvoice(admin, 'ME-1', addDays(now, -100), addDays(now, -10), OVERDUE_BAL);
    await insertInvoice(admin, 'ME-2', addDays(now, -20), addDays(now, 3), DUE_SOON_BAL);
    await insertInvoice(admin, 'ME-4', addDays(now, -100), addDays(now, -95), OLD_BAL);
    await insertInvoice(admin, 'ME-3', addDays(now, -5), addDays(now, 90), FUTURE_BAL);
    await insertBill(admin, 'MEB-1', addDays(now, -100), addDays(now, -10), AP_OVERDUE);
    await insertBill(admin, 'MEB-2', addDays(now, -20), addDays(now, 3), AP_DUE_SOON);
    await insertBill(admin, 'MEB-3', addDays(now, -100), addDays(now, -95), AP_OLD);
    await admin.query(
      `INSERT INTO bank_reconciliations (company_id, bank_account_id, statement_date, status, started_by, completed_at)
       VALUES ($1,$2,'2026-03-03','completed',$3,'2026-03-03 10:00:00+00')`, [COMPANY, BANK, COMPANY]);
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    await cleanup(admin);
    await admin.end();
  });

  it('the fixture really separates the two definitions', async () => {
    const summary = await getAROutstandingSummary(COMPANY);
    const rewound = (await getARAging(COMPANY, periodEnd))
      .reduce((a, b) => a + b.days30 + b.days60 + b.days90 + b.days120Plus, 0);
    expect(summary.overdueAmount).toBeCloseTo(OVERDUE_BAL + OLD_BAL, 2);
    expect(rewound).toBeCloseTo(OVERDUE_BAL + OLD_BAL + DUE_SOON_BAL, 2);
  });

  it('card overdue equals the list-tile aggregate and is formatted as money', async () => {
    const summary = await getAROutstandingSummary(COMPANY);
    const wb = await getMonthEndWorkbench(COMPANY, period);
    const sales = wb.cards.find((c) => c.id === 'sales')!;
    expect(sales.primary).toBe(`${formatMoney(summary.overdueAmount)} overdue`);
    expect(summary.overdueAmount).toBeCloseTo(OVERDUE_BAL + OLD_BAL, 2);
    expect(sales.secondary).toBe(`${formatMoney(OVERDUE_BAL + OLD_BAL + DUE_SOON_BAL + FUTURE_BAL)} outstanding · 1 customers`);
  });

  it('Purchases card in an open period ages as at today, not the future period end', async () => {
    const rewound = (await getAPAging(COMPANY, periodEnd))
      .reduce((a, b) => a + b.days30 + b.days60 + b.days90 + b.days120Plus, 0);
    expect(rewound).toBeCloseTo(AP_OVERDUE + AP_OLD + AP_DUE_SOON, 2);
    const purchases = (await getMonthEndWorkbench(COMPANY, period)).cards.find((c) => c.id === 'purchases')!;
    expect(purchases.primary).toBe(`${formatMoney(AP_OVERDUE + AP_OLD)} overdue`);
    expect(purchases.secondary).toBe(`${formatMoney(AP_OVERDUE + AP_OLD + AP_DUE_SOON)} outstanding · 1 suppliers`);
  });

  it('banking card prints the last reconciliation as dd MMM yyyy', async () => {
    const wb = await getMonthEndWorkbench(COMPANY, period);
    const banking = wb.cards.find((c) => c.id === 'banking')!;
    expect(banking.secondary).toContain('last recon 03 Mar 2026');
  });

  it('a closed period still reads the aged debtors report at its end date', async () => {
    // Two months back: its end is 31..92 days ago, so ME-4 (due 95 days ago) is
    // overdue then and ME-1 (due 10 days ago) is not. Today's aggregate says 1 070.
    const back = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const closed = `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}`;
    const closedEnd = fmtDate(new Date(back.getFullYear(), back.getMonth() + 1, 0));
    const expected = (await getARAging(COMPANY, closedEnd))
      .reduce((a, b) => a + b.days30 + b.days60 + b.days90 + b.days120Plus, 0);
    expect(expected).toBeCloseTo(OLD_BAL, 2);
    const sales = (await getMonthEndWorkbench(COMPANY, closed)).cards.find((c) => c.id === 'sales')!;
    expect(sales.primary).toBe(`${formatMoney(OLD_BAL)} overdue`);
    const purchases = (await getMonthEndWorkbench(COMPANY, closed)).cards.find((c) => c.id === 'purchases')!;
    expect(purchases.primary).toBe(`${formatMoney(AP_OLD)} overdue`);
  });
});

async function insertBill(admin: Pool, number: string, invoiceDate: string, dueDate: string, total: number) {
  await admin.query(
    `INSERT INTO supplier_invoices
       (company_id, supplier_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$3,$4,$5,'approved',$6,0,$7)`,
    [COMPANY, SUPPLIER, number, invoiceDate, dueDate, total, COMPANY],
  );
}

async function insertInvoice(admin: Pool, number: string, invoiceDate: string, dueDate: string, total: number) {
  await admin.query(
    `INSERT INTO customer_invoices
       (company_id, client_id, customer_id, invoice_number, invoice_date, due_date, status, total_amount, amount_paid, created_by)
     VALUES ($1,$2,$2,$3,$4,$5,'approved',$6,0,$7)`,
    [COMPANY, CUSTOMER, number, invoiceDate, dueDate, total, COMPANY],
  );
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM bank_reconciliations WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM supplier_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM suppliers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customer_invoices WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM gl_accounts WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM customers WHERE company_id = $1', [COMPANY]);
  await admin.query('DELETE FROM companies WHERE id = $1', [COMPANY]);
}
