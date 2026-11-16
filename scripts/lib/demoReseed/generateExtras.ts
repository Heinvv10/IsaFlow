/**
 * Opening capital, monthly bank charges and interest, fixed assets (their
 * depreciation history is posted afterwards by the app's own depreciation
 * service, see write.ts), practice clients and time, and expense claims.
 */

import { addDays, addMonths, at0900, dayOf, monthEnd, monthLabel, ym } from './dates';
import { ASSETS, PRACTICE_CLIENTS, demoPhone } from './fixtures';
import { EMPLOYEES } from './employees';
import type { AssetBills } from './generatePurchases';
import type { JEntry } from './journal';
import { between, money, pick, uuidFrom } from './rng';
import type { Ctx } from './types';

export const OPENING_CAPITAL_CENTS = 750_000_00;

export function openingCapital(ctx: Ctx): JEntry {
  const { accounts } = ctx.input;
  return ctx.jb.add({
    date: ctx.win.windowStart, description: 'Opening capital introduced', reference: 'OPENING', source: 'manual',
    bankText: 'CAPITAL INTRODUCED',
    lines: [
      { accountId: accounts.bank, debit: OPENING_CAPITAL_CENTS, credit: 0, description: 'Opening bank balance' },
      { accountId: accounts.openingEquity, debit: 0, credit: OPENING_CAPITAL_CENTS, description: 'Opening balance equity' },
    ],
  });
}

/** Raise the opening capital (both sides) so the bank never dips below zero. */
export function topUpCapital(entry: JEntry, extraCents: number): void {
  entry.lines[0]!.debit += extraCents;
  entry.lines[1]!.credit += extraCents;
}

export function bankChargesAndInterest(ctx: Ctx): void {
  const { accounts } = ctx.input;
  for (const { year, month } of ctx.win.months) {
    const d = monthEnd(year, month);
    if (d > ctx.win.today) continue;
    const fee = between(ctx.rng, 18_000, 42_000);
    ctx.jb.add({
      date: d, description: `Bank charges ${monthLabel(year, month)}`, reference: 'BANK FEES', source: 'manual', bankText: 'BANK CHARGES',
      lines: [
        { accountId: accounts.bankCharges, debit: fee, credit: 0, description: 'Monthly bank charges' },
        { accountId: accounts.bank, debit: 0, credit: fee, description: 'Monthly bank charges' },
      ],
    });
    const interest = between(ctx.rng, 15_000, 90_000);
    ctx.jb.add({
      date: d, description: `Credit interest ${monthLabel(year, month)}`, reference: 'INTEREST', source: 'manual', bankText: 'CREDIT INTEREST',
      lines: [
        { accountId: accounts.bank, debit: interest, credit: 0, description: 'Interest received' },
        { accountId: accounts.otherIncome, debit: 0, credit: interest, description: 'Interest received' },
      ],
    });
  }
}

export function assets(ctx: Ctx, bills: AssetBills): void {
  const { companyId, actorId, accounts } = ctx.input;
  ASSETS.forEach((a, i) => {
    const b = bills.get(i);
    if (!b) throw new Error(`asset ${a.number} has no purchase bill`);
    ctx.rows.assets.push({
      id: uuidFrom(ctx.rng), company_id: companyId, asset_number: a.number, name: a.name, category: a.kind === 'vehicles' ? 'Vehicles' : 'Equipment',
      purchase_date: b.date, purchase_price: money(b.costCents), salvage_value: money(0), useful_life_years: a.lifeYears,
      depreciation_method: 'straight_line', tax_useful_life_years: a.lifeYears, tax_depreciation_method: 'straight_line',
      accumulated_depreciation: money(0), gl_asset_account_id: a.kind === 'vehicles' ? accounts.vehicles : accounts.equipment,
      gl_depreciation_account_id: accounts.accumulatedDepreciation, gl_expense_account_id: accounts.depreciationExpense,
      status: 'available', location: 'Head office', created_by: actorId,
    });
  });
}

export function practice(ctx: Ctx): void {
  const { companyId, actorId } = ctx.input;
  const { today } = ctx.win;
  const cur = ym(today);
  const jobs: Array<{ id: string; clientId: string; open: boolean; rate: number }> = [];
  PRACTICE_CLIENTS.forEach((c, i) => {
    ctx.rows.practice_clients.push({ id: c.id, company_id: companyId, legal_name: c.legal, trading_name: c.trading, billing_model: c.billing, status: 'active' });
    ctx.rows.practice_client_contacts.push({
      id: uuidFrom(ctx.rng), company_id: companyId, client_id: c.id, name: c.contact, email: `finance@${c.slug}.example.co.za`,
      phone: demoPhone('011', i + 60), role: 'Owner', is_primary: true,
    });
  });
  for (let back = 2; back >= 0; back--) {
    const { year, month } = addMonths(cur.year, cur.month, -back);
    for (const c of PRACTICE_CLIENTS.slice(0, 2)) {
      const open = back === 0;
      const id = uuidFrom(ctx.rng);
      const due = open ? addDays(today, between(ctx.rng, 3, 14)) : dayOf(year, month, 25);
      ctx.rows.practice_jobs.push({
        id, company_id: companyId, practice_client_id: c.id, title: `Monthly accounts ${monthLabel(year, month)}`,
        due_date: due, priority: 'normal', status: open ? 'in_progress' : 'complete', billing_type: c.billing,
        budgeted_hours: 6, created_by: actorId, completed_at: open ? null : at0900(due),
      });
      jobs.push({ id, clientId: c.id, open, rate: 650 });
    }
  }
  const tasks = ['Bank reconciliation', 'Capture supplier invoices', 'VAT working papers', 'Management accounts review', 'Client query follow-up'];
  for (const j of jobs) {
    const n = between(ctx.rng, 5, 8);
    for (let k = 0; k < n; k++) {
      const date = addDays(today, -between(ctx.rng, j.open ? 0 : 20, j.open ? 10 : 85));
      const hours = between(ctx.rng, 1, 8) / 2;
      const approved = !j.open;
      ctx.rows.time_entries.push({
        id: uuidFrom(ctx.rng), company_id: companyId, user_id: actorId, task_description: pick(ctx.rng, tasks), entry_date: date,
        hours, rate: money(j.rate * 100), billable: true, status: approved ? 'approved' : 'submitted', practice_client_id: j.clientId,
        job_id: j.id, applied_rate: money(j.rate * 100), line_total: money(Math.round(hours * j.rate * 100)), origin: 'manual',
        approved_by: approved ? actorId : null, approved_at: approved ? at0900(date) : null,
      });
    }
  }
}

export function expenseClaims(ctx: Ctx): void {
  const { companyId, actorId, accounts } = ctx.input;
  const { today } = ctx.win;
  const claims = [
    { emp: EMPLOYEES[1]!, status: 'approved', back: 35, title: 'Client visit mileage and tolls', lines: [['Toll fees for client site visits', 'Toll plaza'], ['Parking at client offices', 'City parking garage']] },
    { emp: EMPLOYEES[3]!, status: 'submitted', back: 12, title: 'Installation consumables', lines: [['Cable ties and wall plugs', 'Hardware store']] },
    { emp: EMPLOYEES[4]!, status: 'draft', back: 3, title: 'Client lunch meeting', lines: [['Lunch with prospective client', 'Restaurant']] },
  ] as const;
  const seq = new Map<string, number>();
  for (const c of claims) {
    const date = addDays(today, -c.back);
    const year = date.slice(0, 4);
    const n = (seq.get(year) ?? 0) + 1;
    seq.set(year, n);
    const id = uuidFrom(ctx.rng);
    let total = 0;
    let vat = 0;
    for (const [description, merchant] of c.lines) {
      const incl = between(ctx.rng, 12_000, 68_000);
      const v = Math.round((incl * ctx.input.vatRatePct) / (100 + ctx.input.vatRatePct));
      total += incl;
      vat += v;
      ctx.rows.expense_claim_lines.push({
        id: uuidFrom(ctx.rng), claim_id: id, company_id: companyId, line_date: date, description, merchant,
        amount: money(incl), vat_amount: money(v), vat_code: 'standard', gl_account_id: accounts.expenseByCode['5400']!,
      });
    }
    ctx.rows.expense_claims.push({
      id, company_id: companyId, employee_id: c.emp.id, claim_number: `CL-${year}-${String(n).padStart(4, '0')}`, claim_date: date,
      title: c.title, description: c.title, status: c.status, total_amount: money(total), total_vat: money(vat), created_by: actorId,
      submitted_at: c.status === 'draft' ? null : at0900(date),
      approved_by: c.status === 'approved' ? actorId : null, approved_at: c.status === 'approved' ? at0900(addDays(date, 2)) : null,
    });
  }
}
