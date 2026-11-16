/**
 * Suppliers, bills and supplier payments with their journals. A healthy payer:
 * bills older than 90 days are paid; 8-12 open, at most three overdue and none
 * more than 60 days; one part-paid; one draft in the current month. The six
 * fixed assets are bought on bills coded to the asset accounts (PLAN 5.8).
 */

import { addDays, at0900, minDay, monthEnd } from './dates';
import { ASSETS, SUPPLIERS, demoPhone, type SupplierFixture } from './fixtures';
import { ageDays, dayInMonth, nextDocNumber, shortName, shuffled, vatCents } from './docs';
import { between, money, pick, uuidFrom } from './rng';
import type { Ctx } from './types';

interface Bill {
  id: string; number: string; supplier: SupplierFixture; date: string; description: string; accountId: string;
  subtotal: number; tax: number; total: number; status: 'paid' | 'partially_paid' | 'approved' | 'draft';
  paid: number; paidOn: string | null; assetIndex: number | null;
}

/** Bill id per asset fixture index, for the assets rows (generateExtras). */
export type AssetBills = Map<number, { date: string; costCents: number }>;

function bill(ctx: Ctx, s: SupplierFixture, date: string, assetIndex: number | null): Bill {
  const a = assetIndex === null ? null : ASSETS[assetIndex]!;
  const subtotal = (a ? between(ctx.rng, a.priceLo / 100, a.priceHi / 100) * 100 : between(ctx.rng, s.bandLo, s.bandHi)) * 100;
  const tax = vatCents(subtotal, ctx.input.vatRatePct);
  const accountId = a ? (a.kind === 'vehicles' ? ctx.input.accounts.vehicles : ctx.input.accounts.equipment)
    : ctx.input.accounts.expenseByCode[s.expenseCode]!;
  return {
    id: uuidFrom(ctx.rng), number: '', supplier: s, date, description: a ? a.name : s.line, accountId,
    subtotal, tax, total: subtotal + tax, status: 'paid', paid: 0, paidOn: null, assetIndex,
  };
}

function assignStatuses(ctx: Ctx, bills: Bill[]): void {
  const { today } = ctx.win;
  const inBand = (lo: number, hi: number) => bills.filter((b) => b.assetIndex === null && ageDays(b.date, today) >= lo && ageDays(b.date, today) <= hi);
  const recent = inBand(0, 30).sort((a, b) => (a.date < b.date ? 1 : -1));
  const today0 = recent.filter((b) => b.date === today).length;
  const open = new Set(recent.slice(0, Math.min(recent.length, Math.max(today0, between(ctx.rng, 6, 9)))));
  const overdue = [...shuffled(ctx.rng, inBand(31, 60)).slice(0, between(ctx.rng, 1, 2)), ...shuffled(ctx.rng, inBand(61, 90)).slice(0, 1)];
  overdue.forEach((b) => open.add(b));
  for (const b of bills) {
    if (b === overdue[0]) {
      b.status = 'partially_paid';
      b.paid = Math.round((b.total * between(ctx.rng, 40, 60)) / 100);
      b.paidOn = minDay(today, addDays(b.date, between(ctx.rng, 25, 30)));
    } else if (open.has(b)) {
      b.status = 'approved';
    } else {
      b.status = 'paid';
      b.paid = b.total;
      b.paidOn = minDay(today, addDays(b.date, between(ctx.rng, 20, 40)));
    }
  }
}

function writeBill(ctx: Ctx, b: Bill): void {
  const { companyId, actorId, accounts } = ctx.input;
  let journalId: string | null = null;
  if (b.status !== 'draft') {
    journalId = ctx.jb.add({
      date: b.date, description: `Supplier invoice ${b.number} ${b.supplier.name}`, reference: b.number, source: 'auto_supplier_invoice',
      lines: [
        { accountId: b.accountId, debit: b.subtotal, credit: 0, description: b.description },
        { accountId: accounts.vatInput, debit: b.tax, credit: 0, description: `VAT Input: ${b.number}`, vatType: 'standard' as const },
        { accountId: accounts.payable, debit: 0, credit: b.total, description: `AP: ${b.number}` },
      ],
    }).id;
  }
  ctx.rows.supplier_invoices.push({
    id: b.id, company_id: companyId, invoice_number: b.number, supplier_id: b.supplier.id, invoice_date: b.date,
    due_date: addDays(b.date, 30), due_date_source: 'terms', received_date: b.date,
    subtotal: money(b.subtotal), tax_rate: ctx.input.vatRatePct, tax_amount: money(b.tax), total_amount: money(b.total),
    functional_total: money(b.total), amount_paid: money(b.paid), status: b.status,
    reference: b.number, gl_journal_entry_id: journalId, created_by: actorId,
    approved_by: b.status === 'draft' ? null : actorId, approved_at: b.status === 'draft' ? null : at0900(b.date),
    paid_at: b.status === 'paid' && b.paidOn ? at0900(b.paidOn) : null, payment_matched: false,
  });
  ctx.rows.supplier_invoice_items.push({
    id: uuidFrom(ctx.rng), supplier_invoice_id: b.id, description: b.description, quantity: 1, unit_price: money(b.subtotal),
    tax_rate: ctx.input.vatRatePct, tax_amount: money(b.tax), line_total: money(b.subtotal), gl_account_id: b.accountId,
    vat_classification: 'standard',
  });
  if (b.paid > 0 && b.paidOn) writePayment(ctx, b);
}

function writePayment(ctx: Ctx, b: Bill): void {
  const { companyId, actorId, accounts } = ctx.input;
  const number = nextDocNumber(ctx, 'supplier_payment');
  const date = b.paidOn!;
  const entry = ctx.jb.add({
    date, description: `Supplier payment ${number} ${b.supplier.name}`, reference: number, source: 'auto_supplier_payment',
    bankText: `EFT PMT ${shortName(b.supplier.name)} ${b.number}`,
    lines: [
      { accountId: accounts.payable, debit: b.paid, credit: 0, description: `AP: ${b.number}` },
      { accountId: accounts.bank, debit: 0, credit: b.paid, description: `Payment: ${number}` },
    ],
  });
  const id = uuidFrom(ctx.rng);
  ctx.rows.supplier_payments.push({
    id, company_id: companyId, payment_number: number, supplier_id: b.supplier.id, payment_date: date,
    total_amount: money(b.paid), payment_method: 'eft', bank_account_id: accounts.bank, reference: b.number,
    description: `Payment for ${b.number}`, status: 'processed', gl_journal_entry_id: entry.id,
    created_by: actorId, processed_at: at0900(date),
  });
  ctx.rows.payment_allocations.push({ id: uuidFrom(ctx.rng), payment_id: id, invoice_id: b.id, amount_allocated: money(b.paid) });
}

export function generatePurchases(ctx: Ctx): AssetBills {
  const { companyId } = ctx.input;
  const { today, months } = ctx.win;
  SUPPLIERS.forEach((s, i) => ctx.rows.suppliers.push({
    id: s.id, company_id: companyId, name: s.name, company_name: s.name, email: `accounts@${s.slug}.example.co.za`,
    phone: demoPhone(s.areaCode, i + 40), contact_person: s.contact, payment_terms: 30, payment_terms_type: 'invoice_days',
    is_active: true,
  }));
  const bills: Bill[] = [];
  months.forEach(({ year, month }, mi) => {
    for (const s of SUPPLIERS) {
      // The current month: only the share of suppliers whose bill would have arrived by today.
      if (mi === months.length - 1 && between(ctx.rng, 1, Number(monthEnd(year, month).slice(8, 10))) > Number(today.slice(8, 10))) continue;
      bills.push(bill(ctx, s, dayInMonth(ctx.rng, year, month, today), null));
    }
    const extra = mi === months.length - 1 ? 0 : between(ctx.rng, 0, 4);
    for (let k = 0; k < extra; k++) bills.push(bill(ctx, pick(ctx.rng, SUPPLIERS), dayInMonth(ctx.rng, year, month, today), null));
  });
  ASSETS.forEach((a, i) => {
    const m = months[a.monthOffset]!;
    bills.push(bill(ctx, SUPPLIERS[a.supplierIndex]!, dayInMonth(ctx.rng, m.year, m.month, today), i));
  });
  bills.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  assignStatuses(ctx, bills);
  const cur = months[months.length - 1]!;
  const draft = bill(ctx, SUPPLIERS[0]!, dayInMonth(ctx.rng, cur.year, cur.month, today), null);
  draft.status = 'draft';
  bills.push(draft);
  const perSupplier = new Map<string, number>();
  for (const b of bills) {
    const n = (perSupplier.get(b.supplier.id) ?? 1000) + 1;
    perSupplier.set(b.supplier.id, n);
    b.number = `${b.supplier.initials}-${n}`;
  }
  const assetBills: AssetBills = new Map();
  for (const b of bills) {
    writeBill(ctx, b);
    if (b.assetIndex !== null) assetBills.set(b.assetIndex, { date: b.date, costCents: b.subtotal });
  }
  return assetBills;
}
