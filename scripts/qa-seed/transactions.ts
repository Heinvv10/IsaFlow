import { randomUUID } from 'crypto';
import type { TaggedSql, Customer, Supplier } from './types';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export async function seedCustomerInvoices(
  sql: TaggedSql, companyId: string, coa: Map<string, string>, customers: Customer[], adminId: string,
): Promise<void> {
  const revGl = coa.get('4100')!;
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
    const exists = await sql`SELECT id FROM customer_invoices WHERE company_id = ${companyId}::uuid AND invoice_number = ${inv.num} LIMIT 1` as Array<{ id: string }>;
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
        ${invId}::uuid, ${companyId}::uuid, ${inv.num}, ${cust.id}::uuid,
        ${inv.sub}, 15, ${tax}, ${total}, ${inv.paid},
        ${inv.status}, ${invDate}::date, ${dueDate}::date, ${inv.desc}, ${adminId}, 'ZAR'
      )
    `;
    await sql`
      INSERT INTO customer_invoice_items (invoice_id, description, quantity, unit_price, amount, tax_rate, gl_account_id, currency_code)
      VALUES (${invId}::uuid, ${inv.desc}, 1, ${inv.sub}, ${inv.sub}, 15, ${revGl}::uuid, 'ZAR')
    `;
  }
  console.log('[customer_invoices] 8 (3 draft, 5 approved — incl. 1 partial-paid, 1 fully-paid via amount_paid)');
}

export async function seedSupplierInvoices(
  sql: TaggedSql, companyId: string, suppliers: Supplier[], adminId: string,
): Promise<void> {
  const bills = [
    { num: 'QA-BILL-001', sup: 0, days: 8,  sub: 850,  desc: 'Office stationery — March' },
    { num: 'QA-BILL-002', sup: 1, days: 15, sub: 1450, desc: 'Internet + phone April' },
    { num: 'QA-BILL-003', sup: 2, days: 22, sub: 1200, desc: 'Office cleaning April' },
    { num: 'QA-BILL-004', sup: 3, days: 38, sub: 480,  desc: 'Courier deliveries March' },
  ];
  for (const b of bills) {
    const exists = await sql`SELECT id FROM supplier_invoices WHERE company_id = ${companyId}::uuid AND invoice_number = ${b.num} LIMIT 1` as Array<{ id: string }>;
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
        ${companyId}::uuid, ${b.num}, ${sup.id}::uuid, ${daysAgo(b.days)}::date, ${daysAgo(b.days - 30)}::date,
        ${b.sub}, 15, ${tax}, ${total}, 0,
        'approved', 'ZAR', ${b.desc}, ${adminId}
      )
    `;
  }
  console.log('[supplier_invoices] 4 unpaid');
}

export async function seedBankTransactions(
  sql: TaggedSql, companyId: string, bankGlAccountId: string, customers: Customer[],
): Promise<void> {
  const existing = await sql`SELECT COUNT(*)::int AS cnt FROM bank_transactions WHERE company_id = ${companyId}::uuid AND bank_reference LIKE 'QA-BT-%'` as Array<{ cnt: number }>;
  if ((existing[0]?.cnt ?? 0) >= 5) {
    console.log(`[bank_transactions] exists (${existing[0]!.cnt})`);
    return;
  }
  const txns = [
    { ref: 'QA-BT-001', days: 3,  amt: 5175.00,  desc: `EFT ${customers[0]!.name} INV QA-INV-003` },
    { ref: 'QA-BT-002', days: 6,  amt: 6210.00,  desc: `${customers[1]!.name} payment INV-007` },
    { ref: 'QA-BT-003', days: 10, amt: 1092.50,  desc: `${customers[4]!.name} small payment` },
    { ref: 'QA-BT-004', days: 14, amt: 12500.00, desc: 'EFT FROM UNKNOWN CLIENT' },
    { ref: 'QA-BT-005', days: 18, amt: 875.00,   desc: 'BANK CHARGES MARCH' },
  ];
  for (const t of txns) {
    await sql`
      INSERT INTO bank_transactions (bank_account_id, transaction_date, value_date, amount, description, reference, bank_reference, status, company_id)
      VALUES (${bankGlAccountId}::uuid, ${daysAgo(t.days)}::date, ${daysAgo(t.days)}::date, ${t.amt}, ${t.desc}, ${t.ref}, ${t.ref}, 'imported', ${companyId}::uuid)
    `;
  }
  console.log('[bank_transactions] 5 unallocated (3 invoice-matchable, 2 unmatched)');
}
