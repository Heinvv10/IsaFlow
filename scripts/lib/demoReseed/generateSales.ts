/**
 * Customer invoices and receipts with their journals, aged like a healthy
 * small business (PLAN 5.4): everything older than 120 days is paid except one
 * invoice 91-150 days overdue; 12-18 open in all, most not yet due, a few in
 * each overdue band, two part-paid; two drafts in the current month.
 */

import { addDays, at0900, minDay } from './dates';
import { CUSTOMERS } from './fixtures';
import { ageDays, dayInMonth, monthCount, nextDocNumber, shortName, shuffled, vatCents } from './docs';
import { salesLines } from './generateCustomers';
import { between, money, pick, uuidFrom } from './rng';
import type { Ctx } from './types';

interface Inv {
  id: string; number: string; customerId: string; customerName: string; date: string;
  lines: ReturnType<typeof salesLines>; subtotal: number; tax: number; total: number;
  status: 'paid' | 'partially_paid' | 'sent' | 'draft'; paid: number; paidOn: string | null;
}

function buildInvoice(ctx: Ctx, date: string, project: boolean): Inv {
  const customer = pick(ctx.rng, CUSTOMERS);
  const lines = project
    ? [{ description: 'Office network rollout project', qty: 1, unit: between(ctx.rng, 900, 1800) * 10_000, amount: 0, accountId: ctx.input.accounts.salesRevenue }]
    : salesLines(ctx, between(ctx.rng, 2, 4));
  for (const l of lines) l.amount = l.qty * l.unit;
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const tax = vatCents(subtotal, ctx.input.vatRatePct);
  return {
    id: uuidFrom(ctx.rng), number: '', customerId: customer.id, customerName: customer.name, date, lines,
    subtotal, tax, total: subtotal + tax, status: 'paid', paid: 0, paidOn: null,
  };
}

/** Choose which invoices stay open, by age band; the rest are paid. */
function assignStatuses(ctx: Ctx, invs: Inv[]): void {
  const { today } = ctx.win;
  const band = (lo: number, hi: number) => invs.filter((v) => { const a = ageDays(v.date, today); return a >= lo && a <= hi; });
  const notDue = band(0, 30).sort((a, b) => (a.date < b.date ? 1 : -1));
  const dueToday = notDue.filter((v) => v.date === today).length;
  const k = Math.min(notDue.length, Math.max(dueToday, between(ctx.rng, 7, 11)));
  const open = new Set(notDue.slice(0, k));
  const overdue: Inv[] = [];
  for (const [lo, hi, nLo, nHi] of [[31, 60, 2, 3], [61, 90, 1, 2], [91, 120, 1, 1], [121, 180, 1, 1]] as const) {
    const chosen = shuffled(ctx.rng, band(lo, hi)).slice(0, between(ctx.rng, nLo, nHi));
    chosen.forEach((v) => open.add(v));
    if (lo <= 61) overdue.push(...chosen);
  }
  const partial = new Set(overdue.slice(0, 2));
  for (const v of invs) {
    if (partial.has(v)) {
      v.status = 'partially_paid';
      v.paid = Math.round((v.total * between(ctx.rng, 30, 60)) / 100);
      v.paidOn = minDay(today, addDays(v.date, between(ctx.rng, 10, 30)));
    } else if (open.has(v)) {
      v.status = 'sent';
    } else {
      v.status = 'paid';
      v.paid = v.total;
      v.paidOn = minDay(today, addDays(v.date, between(ctx.rng, 18, 45)));
    }
  }
}

function writeInvoice(ctx: Ctx, v: Inv): void {
  const { companyId, actorId, accounts } = ctx.input;
  let journalId: string | null = null;
  if (v.status !== 'draft') {
    journalId = ctx.jb.add({
      date: v.date, description: `Customer invoice ${v.number}`, reference: v.number, source: 'auto_invoice',
      lines: [
        { accountId: accounts.receivable, debit: v.total, credit: 0, description: `AR: ${v.number}` },
        ...v.lines.map((l) => ({ accountId: l.accountId, debit: 0, credit: l.amount, description: `Revenue: ${v.number}` })),
        { accountId: accounts.vatOutput, debit: 0, credit: v.tax, description: `VAT Output: ${v.number}`, vatType: 'standard' as const },
      ],
    }).id;
  }
  ctx.rows.customer_invoices.push({
    id: v.id, company_id: companyId, invoice_number: v.number, customer_id: v.customerId, client_id: v.customerId,
    subtotal: money(v.subtotal), tax_rate: ctx.input.vatRatePct, tax_amount: money(v.tax), total_amount: money(v.total),
    functional_total: money(v.total), amount_paid: money(v.paid), status: v.status,
    invoice_date: v.date, due_date: addDays(v.date, 30), due_date_source: 'terms',
    sent_at: v.status === 'draft' ? null : at0900(v.date), paid_at: v.status === 'paid' && v.paidOn ? at0900(v.paidOn) : null,
    gl_journal_entry_id: journalId, created_by: actorId,
    approved_by: v.status === 'draft' ? null : actorId, approved_at: v.status === 'draft' ? null : at0900(v.date),
  });
  v.lines.forEach((l, i) => ctx.rows.customer_invoice_items.push({
    id: uuidFrom(ctx.rng), invoice_id: v.id, description: l.description, quantity: l.qty, unit_price: money(l.unit),
    amount: money(l.amount), tax_rate: ctx.input.vatRatePct, gl_account_id: l.accountId, line_position: i + 1,
  }));
  if (v.paid > 0 && v.paidOn) writeReceipt(ctx, v);
}

function writeReceipt(ctx: Ctx, v: Inv): void {
  const { companyId, actorId, accounts } = ctx.input;
  const number = nextDocNumber(ctx, 'customer_receipt');
  const date = v.paidOn!;
  const entry = ctx.jb.add({
    date, description: `Customer receipt ${number}`, reference: number, source: 'auto_payment',
    bankText: `EFT REC ${shortName(v.customerName)} ${v.number}`,
    lines: [
      { accountId: accounts.bank, debit: v.paid, credit: 0, description: `Receipt: ${number}` },
      { accountId: accounts.receivable, debit: 0, credit: v.paid, description: `AR: ${v.number}` },
    ],
  });
  const id = uuidFrom(ctx.rng);
  ctx.rows.customer_payments.push({
    id, company_id: companyId, payment_number: number, client_id: v.customerId, payment_date: date,
    total_amount: money(v.paid), payment_method: 'eft', bank_reference: v.number, bank_account_id: accounts.bank,
    description: `Payment for ${v.number}`, status: 'confirmed', gl_journal_entry_id: entry.id,
    created_by: actorId, confirmed_by: actorId, confirmed_at: at0900(date),
  });
  ctx.rows.customer_payment_allocations.push({ id: uuidFrom(ctx.rng), payment_id: id, invoice_id: v.id, amount_allocated: money(v.paid) });
}

export function generateSales(ctx: Ctx): void {
  const { today, months } = ctx.win;
  const invs: Inv[] = [];
  months.forEach(({ year, month }, i) => {
    const n = monthCount(ctx.rng, year, month, today, 10, 14);
    for (let k = 0; k < n; k++) invs.push(buildInvoice(ctx, dayInMonth(ctx.rng, year, month, today), false));
    if (i % 2 === 1 && i < months.length - 1) invs.push(buildInvoice(ctx, dayInMonth(ctx.rng, year, month, today), true));
  });
  invs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  assignStatuses(ctx, invs);
  const drafts = [0, 1].map(() => {
    const d = buildInvoice(ctx, dayInMonth(ctx.rng, Number(today.slice(0, 4)), Number(today.slice(5, 7)), today), false);
    d.status = 'draft';
    return d;
  });
  for (const v of [...invs, ...drafts]) v.number = nextDocNumber(ctx, 'customer_invoice');
  for (const v of [...invs, ...drafts]) writeInvoice(ctx, v);
}
