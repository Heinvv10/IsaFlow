import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { DEMO_MONTHS_BACK, DEMO_MONTHS_FORWARD } from '../../../../scripts/lib/demoReseed/constants';
import { DATED, FUTURE_ALLOWED } from '../../../../scripts/lib/demoReseed/dated';
import { addDays, daysBetween, windowFor } from '../../../../scripts/lib/demoReseed/dates';
import { ISO_DATE_IN_TEXT } from '../../../../scripts/lib/demoReseed/denylist';
import { generateDemoData } from '../../../../scripts/lib/demoReseed/generate';
import { SEED_TABLES, type DemoData, type Row } from '../../../../scripts/lib/demoReseed/types';
import { UnsupportedTaxYearError } from '../../../../src/modules/accounting/services/payroll/taxTables';
import { ACCOUNTS, inputFor } from './input';

const TODAYS = ['2026-11-16', '2027-01-01', '2026-10-31', '2026-12-01'];
const SEEDS = [7, 20261116];
const cents = (v: unknown): number => Math.round(Number(v) * 100);
const cache = new Map<string, DemoData>();
const gen = (today: string, seed: number): DemoData => {
  const k = `${today}/${seed}`;
  if (!cache.has(k)) cache.set(k, generateDemoData(inputFor(today, seed)));
  return cache.get(k)!;
};
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(v);
const sum = (rows: Row[], col: string): number => rows.reduce((s, r) => s + cents(r[col]), 0);

describe.each(TODAYS.flatMap((t) => SEEDS.map((s) => [t, s] as const)))('generateDemoData(%s, seed %s)', (today, seed) => {
  const d = gen(today, seed);
  const win = windowFor(today);

  it('dates nothing after today except allowlisted obligations, and nothing before the window', () => {
    const allowed = new Set([...Object.keys(FUTURE_ALLOWED)]);
    for (const table of SEED_TABLES) {
      for (const r of d.rows[table]) {
        for (const [col, v] of Object.entries(r)) {
          if (!isDay(v)) continue;
          const day = v.slice(0, 10);
          const draftEnd = table === 'payroll_run_headers' && col === 'period_end' && r.status === 'draft';
          if (allowed.has(`${table}.${col}`) || draftEnd) {
            expect(daysBetween(today, day), `${table}.${col}`).toBeLessThanOrEqual(FUTURE_ALLOWED[`${table}.${col}`] ?? 31);
            continue;
          }
          expect(day <= today, `${table}.${col} = ${day} after ${today}`).toBe(true);
          if (col !== 'start_date' && col !== 'date_of_birth' && col !== 'effective_from') {
            expect(day >= win.windowStart, `${table}.${col} = ${day} before ${win.windowStart}`).toBe(true);
          }
        }
      }
    }
  });

  it('has exactly 24 window months and no forward months', () => {
    expect(DEMO_MONTHS_FORWARD).toBe(0);
    expect(win.months).toHaveLength(DEMO_MONTHS_BACK + 1);
    expect(win.months).toHaveLength(24);
  });

  it('balances every journal to the cent with at least two one-sided lines', () => {
    const byEntry = new Map<string, { dr: number; cr: number; n: number }>();
    for (const l of d.rows.gl_journal_lines) {
      const dr = cents(l.debit); const cr = cents(l.credit);
      expect(dr > 0 && cr > 0).toBe(false);
      expect(String(l.debit)).toMatch(/^\d+\.\d{2}$/);
      const e = byEntry.get(String(l.journal_entry_id)) ?? { dr: 0, cr: 0, n: 0 };
      byEntry.set(String(l.journal_entry_id), { dr: e.dr + dr, cr: e.cr + cr, n: e.n + 1 });
    }
    expect(byEntry.size).toBe(d.rows.gl_journal_entries.length);
    for (const e of byEntry.values()) { expect(e.dr).toBe(e.cr); expect(e.n).toBeGreaterThanOrEqual(2); }
    expect(sum(d.rows.gl_journal_lines, 'debit')).toBe(sum(d.rows.gl_journal_lines, 'credit'));
  });

  it('keeps the bank positive, 1:1 with bank-account journal lines, reconciled to last month end', () => {
    const bankLines = d.rows.gl_journal_lines.filter((l) => l.gl_account_id === ACCOUNTS.bank);
    expect(d.rows.bank_transactions).toHaveLength(bankLines.length);
    let bal = 0;
    const ordered = [...d.rows.bank_transactions].sort((a, b) => String(a.transaction_date).localeCompare(String(b.transaction_date)));
    for (const t of ordered) { bal += cents(t.amount); expect(bal).toBeGreaterThanOrEqual(0); }
    const reconciled = d.rows.bank_transactions.filter((t) => t.status === 'reconciled');
    expect(reconciled.every((t) => String(t.transaction_date) <= win.lastMonthEnd && t.matched_journal_line_id)).toBe(true);
    expect(d.rows.bank_transactions.filter((t) => String(t.transaction_date) <= win.lastMonthEnd).every((t) => t.status === 'reconciled')).toBe(true);
    const glAtLme = d.rows.gl_journal_lines.filter((l) => l.gl_account_id === ACCOUNTS.bank).reduce((s, l) => {
      const e = d.rows.gl_journal_entries.find((x) => x.id === l.journal_entry_id)!;
      return String(e.entry_date) <= win.lastMonthEnd ? s + cents(l.debit) - cents(l.credit) : s;
    }, 0);
    expect(sum(reconciled, 'amount')).toBe(glAtLme);
    const last = [...d.rows.bank_reconciliations].sort((a, b) => String(b.statement_date).localeCompare(String(a.statement_date)))[0]!;
    expect(cents(last.statement_balance)).toBe(glAtLme);
  });

  it('ages customer invoices like a healthy small business', () => {
    const open = d.rows.customer_invoices.filter((i) => i.status === 'sent' || i.status === 'partially_paid');
    expect(open.length).toBeGreaterThanOrEqual(12);
    expect(open.length).toBeLessThanOrEqual(18);
    const over = (lo: number, hi: number) => open.filter((i) => { const od = daysBetween(String(i.due_date), today); return od >= lo && od <= hi; }).length;
    expect(over(-1000, 0)).toBeGreaterThanOrEqual(7);
    expect(over(-1000, 0)).toBeLessThanOrEqual(11);
    expect(over(1, 30)).toBeGreaterThanOrEqual(2); expect(over(1, 30)).toBeLessThanOrEqual(3);
    expect(over(31, 60)).toBeGreaterThanOrEqual(1); expect(over(31, 60)).toBeLessThanOrEqual(2);
    expect(over(61, 90)).toBe(1);
    expect(over(91, 150)).toBe(1);
    expect(over(151, 100000)).toBe(0);
    expect(open.filter((i) => i.status === 'partially_paid')).toHaveLength(2);
    expect(d.rows.customer_invoices.filter((i) => i.status === 'draft')).toHaveLength(2);
    expect(d.rows.customer_invoices.some((i) => i.status === 'overdue')).toBe(false);
    const bills = d.rows.supplier_invoices.filter((b) => b.status === 'approved' || b.status === 'partially_paid');
    expect(bills.length).toBeGreaterThanOrEqual(8);
    expect(bills.length).toBeLessThanOrEqual(12);
    const overdueBills = bills.filter((b) => String(b.due_date) < today);
    expect(overdueBills.length).toBeLessThanOrEqual(3);
    expect(overdueBills.every((b) => daysBetween(String(b.due_date), today) <= 60)).toBe(true);
  });

  it('ties amount_paid to allocations and the AR and AP control accounts to the documents', () => {
    for (const [docs, allocs] of [[d.rows.customer_invoices, d.rows.customer_payment_allocations], [d.rows.supplier_invoices, d.rows.payment_allocations]] as const) {
      for (const inv of docs) {
        const paid = allocs.filter((a) => a.invoice_id === inv.id).reduce((s, a) => s + cents(a.amount_allocated), 0);
        expect(paid, String(inv.invoice_number)).toBe(cents(inv.amount_paid));
      }
    }
    const control = (acct: string, sign: 1 | -1) => d.rows.gl_journal_lines.filter((l) => l.gl_account_id === acct)
      .reduce((s, l) => s + sign * (cents(l.debit) - cents(l.credit)), 0);
    const open = (rows: Row[]) => rows.filter((r) => r.status !== 'draft').reduce((s, r) => s + cents(r.total_amount) - cents(r.amount_paid), 0);
    expect(control(ACCOUNTS.receivable, 1)).toBe(open(d.rows.customer_invoices));
    expect(control(ACCOUNTS.payable, -1)).toBe(open(d.rows.supplier_invoices));
  });

  it('multiplies invoice lines out exactly and rounds VAT once on the subtotal', () => {
    for (const inv of d.rows.customer_invoices) {
      const items = d.rows.customer_invoice_items.filter((i) => i.invoice_id === inv.id);
      for (const it of items) expect(Math.round(Number(it.quantity) * cents(it.unit_price))).toBe(cents(it.amount));
      expect(sum(items, 'amount')).toBe(cents(inv.subtotal));
      expect(cents(inv.tax_amount)).toBe(Math.round(cents(inv.subtotal) * 0.15));
      expect(cents(inv.total_amount)).toBe(cents(inv.subtotal) + cents(inv.tax_amount));
    }
  });

  it('pays payroll up to last month, drafts the current month, and nothing later', () => {
    const cur = win.months[win.months.length - 1]!;
    for (const h of d.rows.payroll_run_headers) {
      const idx = Number(h.period_year) * 12 + Number(h.period_month);
      expect(idx).toBeLessThanOrEqual(cur.year * 12 + cur.month);
      expect(h.status).toBe(idx === cur.year * 12 + cur.month ? 'draft' : 'paid');
      expect(!(Number(h.period_year) === 2027 && Number(h.period_month) === 2) || h.status === 'draft').toBe(true);
      const lines = d.rows.payroll_run_lines.filter((l) => l.run_id === h.id);
      if (h.status === 'draft') { expect(lines).toHaveLength(0); continue; }
      expect(sum(lines, 'gross_pay')).toBe(cents(h.total_gross));
      expect(sum(lines, 'net_pay')).toBe(cents(h.total_net));
      expect(sum(lines, 'paye')).toBe(cents(h.total_paye));
    }
    expect(d.rows.payroll_run_headers.filter((h) => h.status === 'paid')).toHaveLength(23);
  });

  it('seeds no SARS submission and no ISO-style date in any text', () => {
    for (const table of SEED_TABLES) {
      for (const r of d.rows[table]) {
        for (const [col, v] of Object.entries(r)) {
          if (typeof v !== 'string' || isDay(v) || col.endsWith('_id') || col === 'id' || col === 'explanation'
            || col === 'component_breakdown' || col === 'validation_results') continue;
          expect(ISO_DATE_IN_TEXT.test(v), `${table}.${col}: ${v}`).toBe(false);
          expect(/\b(submitted to sars|filed with sars|accepted by sars)\b/i.test(v)).toBe(false);
        }
      }
    }
  });
});

describe('generateDemoData determinism and refusals', () => {
  it('gives deep-equal output for the same date and seed, and differs for another seed', () => {
    expect(generateDemoData(inputFor('2026-11-16', 7))).toEqual(gen('2026-11-16', 7));
    expect(JSON.stringify(gen('2026-11-16', 20261116).rows.customer_invoices)).not.toBe(JSON.stringify(gen('2026-11-16', 7).rows.customer_invoices));
  });

  it('refuses a window whose payroll tax year has no tables (29 Feb 2028), rather than inventing figures', () => {
    expect(() => generateDemoData(inputFor('2028-02-29', 7))).toThrow(UnsupportedTaxYearError);
  });

  it('names every seeded table with a transaction date in the D1 list', () => {
    const listed = new Set(DATED.map((x) => x.table));
    for (const table of SEED_TABLES) {
      const r = gen('2026-11-16', 7).rows[table][0];
      if (!r) continue;
      const dated = Object.entries(r).filter(([c, v]) => isDay(v) && !Object.keys(FUTURE_ALLOWED).includes(`${table}.${c}`)
        && !['date_of_birth', 'effective_from', 'expiry_date', 'due_date', 'created_at', 'started_at'].includes(c));
      if (dated.length > 0) expect(listed.has(table), `${table} has dates ${dated.map(([c]) => c).join(',')} but no DATED entry`).toBe(true);
    }
  });

  it('uses no clock and no Math.random under scripts/lib/demoReseed', () => {
    const dir = 'scripts/lib/demoReseed';
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(/Math\.random/.test(src), f).toBe(false);
      expect(/Date\.now\(/.test(src), f).toBe(false);
      expect(/new Date\(\s*\)/.test(src), f).toBe(false);
    }
  });

  it('never dates a payment after today even when the invoice is today', () => {
    const d = gen('2026-12-01', 7);
    for (const p of [...d.rows.customer_payments, ...d.rows.supplier_payments]) expect(String(p.payment_date) <= '2026-12-01').toBe(true);
    expect(addDays('2026-12-01', 0)).toBe('2026-12-01');
  });
});
