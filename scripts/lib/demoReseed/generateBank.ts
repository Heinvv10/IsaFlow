/**
 * Bank lines from the bank-account journal lines, one each (PLAN 5.5): every
 * line up to last month end is reconciled into that month's completed
 * reconciliation; in the current month the first 60 percent are matched and the
 * rest imported and unlinked, so the bank screen has work to do. One statement
 * import batch per month. No bank feed rows.
 */

import { addDays, at0900, minDay, monthEnd, ym } from './dates';
import { money, uuidFrom } from './rng';
import type { Ctx } from './types';

export function generateBank(ctx: Ctx): void {
  const { companyId, actorId, accounts } = ctx.input;
  const { today, lastMonthEnd } = ctx.win;
  const lines = ctx.jb.bankLines(accounts.bank);
  const byMonth = new Map<string, typeof lines>();
  for (const l of lines) {
    const key = l.entry.date.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), l]);
  }
  let running = 0;
  for (const [key, monthLines] of byMonth) {
    const { year, month } = ym(`${key}-01`);
    const end = monthEnd(year, month);
    const closed = end <= lastMonthEnd;
    const batchId = uuidFrom(ctx.rng);
    const opening = running;
    const reconId = closed ? uuidFrom(ctx.rng) : null;
    const matchedCount = closed ? monthLines.length : Math.ceil(monthLines.length * 0.6);
    monthLines.forEach((l, i) => {
      running += l.amount;
      const linked = i < matchedCount;
      ctx.rows.bank_transactions.push({
        id: uuidFrom(ctx.rng), company_id: companyId, bank_account_id: accounts.bank, transaction_date: l.entry.date,
        value_date: l.entry.date, amount: money(l.amount), description: l.entry.bankText ?? l.entry.description,
        reference: l.entry.reference, status: closed ? 'reconciled' : linked ? 'matched' : 'imported',
        matched_journal_line_id: linked ? l.line.id : null, reconciliation_id: reconId, import_batch_id: batchId, created_by: actorId,
      });
    });
    const statementDate = closed ? end : today;
    ctx.rows.bank_import_batches.push({
      id: batchId, company_id: companyId, bank_account_id: accounts.bank, statement_date: statementDate, bank_format: 'csv',
      opening_balance: money(opening), closing_balance: money(running), transaction_count: monthLines.length,
      source_filename: `statement-${key}.csv`, filename: `statement-${key}.csv`, imported_by: actorId, import_channel: 'upload',
      balance_source: 'running_balance',
    });
    if (reconId) {
      const done = at0900(minDay(today, addDays(end, 3)));
      ctx.rows.bank_reconciliations.push({
        id: reconId, company_id: companyId, bank_account_id: accounts.bank, statement_date: end, statement_balance: money(running),
        gl_balance: money(running), reconciled_balance: money(running), status: 'completed',
        started_by: actorId, started_at: done, completed_by: actorId, completed_at: done, created_by: actorId,
      });
    }
  }
}
