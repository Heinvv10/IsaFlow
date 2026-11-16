/** Customers, their contacts, items and quotes (no ledger effect). */

import { addDays, at0900, addMonths, ym } from './dates';
import { CUSTOMERS, ITEMS, SALES_LINES, demoPhone } from './fixtures';
import { dayInMonth, monthCount, nextDocNumber, vatCents } from './docs';
import { between, money, pick, uuidFrom } from './rng';
import type { Ctx } from './types';

export function generateCustomers(ctx: Ctx): void {
  const { companyId } = ctx.input;
  CUSTOMERS.forEach((c, i) => {
    ctx.rows.customers.push({
      id: c.id, company_id: companyId, name: c.name, email: `accounts@${c.slug}.example.co.za`,
      phone: demoPhone(c.areaCode, i), contact_person: c.contact, billing_address: c.address,
      payment_terms: 30, payment_terms_type: 'invoice_days', is_active: true,
    });
    ctx.rows.customer_contacts.push({
      id: uuidFrom(ctx.rng), customer_id: c.id, company_id: companyId, full_name: c.contact, role: 'Accounts',
      email: `${c.contact.split(' ')[0]!.toLowerCase()}@${c.slug}.example.co.za`, phone: demoPhone(c.areaCode, i + 20), is_primary: true,
    });
  });
  for (const it of ITEMS) {
    const incl = Math.round(it.price * 100 * (1 + ctx.input.vatRatePct / 100));
    ctx.rows.items.push({
      id: uuidFrom(ctx.rng), company_id: companyId, code: it.code, description: it.description, item_type: it.type,
      unit: it.unit, cost_price: money(it.cost * 100), selling_price_excl: money(it.price * 100), selling_price_incl: money(incl),
      sales_account_id: it.type === 'service' ? ctx.input.accounts.serviceRevenue : ctx.input.accounts.salesRevenue,
      is_active: true,
    });
  }
}

/** Invoice-style lines whose quantity times unit price is exactly the amount, in cents. */
export function salesLines(ctx: Ctx, count: number): Array<{ description: string; qty: number; unit: number; amount: number; accountId: string }> {
  const out = [];
  for (let i = 0; i < count; i++) {
    const l = pick(ctx.rng, SALES_LINES);
    const qty = between(ctx.rng, 1, l.qtyMax);
    const unit = between(ctx.rng, l.unitLo, l.unitHi) * 100;
    out.push({
      description: l.description, qty, unit, amount: qty * unit,
      accountId: l.support ? ctx.input.accounts.serviceRevenue : ctx.input.accounts.salesRevenue,
    });
  }
  return out;
}

/** Three quotes a month for the last six months; only open ones may expire after today. */
export function generateQuotes(ctx: Ctx): void {
  const { today } = ctx.win;
  const cur = ym(today);
  for (let back = 5; back >= 0; back--) {
    const { year, month } = addMonths(cur.year, cur.month, -back);
    const n = Math.min(3, monthCount(ctx.rng, year, month, today, 3, 3));
    for (let k = 0; k < n; k++) {
      const date = dayInMonth(ctx.rng, year, month, today);
      const customer = pick(ctx.rng, CUSTOMERS);
      const lines = salesLines(ctx, between(ctx.rng, 1, 3));
      const subtotal = lines.reduce((s, l) => s + l.amount, 0);
      const tax = vatCents(subtotal, ctx.input.vatRatePct);
      const expiry = addDays(date, 30);
      const open = expiry >= today;
      const status = open ? (k === 0 ? 'draft' : 'sent') : pick(ctx.rng, ['accepted', 'declined', 'expired'] as const);
      const id = uuidFrom(ctx.rng);
      ctx.rows.customer_quotes.push({
        id, company_id: ctx.input.companyId, quote_number: nextDocNumber(ctx, 'quotation'), client_id: customer.id,
        customer_name: customer.name, quote_date: date, expiry_date: expiry, status,
        subtotal: money(subtotal), tax_rate: ctx.input.vatRatePct, tax_amount: money(tax), total: money(subtotal + tax),
        terms: 'Valid for 30 days.', created_by: ctx.input.actorId, created_at: at0900(date),
      });
      lines.forEach((l, i) => ctx.rows.customer_quote_lines.push({
        id: uuidFrom(ctx.rng), quote_id: id, description: l.description, quantity: l.qty, unit_price: money(l.unit),
        amount: money(l.amount), tax_rate: ctx.input.vatRatePct, gl_account_id: l.accountId, sort_order: i,
      }));
    }
  }
}
