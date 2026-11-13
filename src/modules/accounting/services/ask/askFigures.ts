/** "Ask IsaFlow" ledger figures: aging, bank, income statement, balance sheet. Each calls the service its page uses. */
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getIncomeStatement } from '@/modules/accounting/services/reports/financialReportingService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { fiscalYearForDate, getFiscalYear } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';
import type { AskIntent } from './askIntents';
import type { ResolvedPeriod } from './askPeriod';
import { describePeriod, missingDayNote, resolveAsAt, resolveWindow, type FiscalYears } from './askPeriod';
import { periodRefusal, rand, reply, type AskAnswer } from './askTypes';

export const r2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const dayBefore = (iso: string): string => new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
function refuseAsAt(intent: AskIntent, today: string, href: string, label: string): AskAnswer {
  const note = missingDayNote(intent.period, today);
  return note ? reply(note, null, [], href, label) : periodRefusal('that', describePeriod(intent.period), AS_AT_HELP, href, label);
}

const AS_AT_HELP = 'Name a month, "this month", "last month" or an exact day ("as at 15 October") and I will give the position as at that date.';

export async function aging(side: 'ar' | 'ap', intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const href = side === 'ar' ? '/accounting/ar-aging' : '/accounting/ap-aging';
  const label = side === 'ar' ? 'Open AR aging' : 'Open AP aging';
  const at = resolveAsAt(intent.period, today);
  if (!at) return refuseAsAt(intent, today, href, label);
  const rows: AgingBucket[] = side === 'ar' ? await getARAging(companyId, at.date) : await getAPAging(companyId, at.date);
  const total = r2(rows.reduce((s, b) => s + num(b.total), 0));
  const top = [...rows].sort((a, b) => num(b.total) - num(a.total)).slice(0, 3).filter((b) => num(b.total) !== 0);
  const head = side === 'ar' ? 'Customers owe you' : 'You owe suppliers';
  return reply(`As at ${at.label}: ${head.toLowerCase()} ${rand(total)} across ${rows.length} ${side === 'ar' ? 'customers' : 'suppliers'}.`, total,
    top.map((b) => ({ label: b.entityName, value: r2(num(b.total)) })), href, label);
}

export async function bank(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const href = intent.id === 'bank_to_allocate' ? '/accounting/bank-transactions' : '/accounting/bank-accounts';
  const label = intent.id === 'bank_to_allocate' ? 'Open bank transactions' : 'Open bank accounts';
  const p = intent.period;
  const current = !p || p.kind === 'this_month' || (p.kind === 'unsupported' && p.said === 'today');
  if (!current) return periodRefusal('bank figures', describePeriod(p), 'Bank figures are as at today only.', href, label);
  const accounts = await getBankAccountsStatus(companyId, { includeInactive: true });
  const active = accounts.filter((a) => a.isActive !== false);
  const inactive = accounts.filter((a) => a.isActive === false);
  if (intent.id === 'bank_to_allocate') {
    const n = active.reduce((s, a) => s + a.unallocatedCount, 0);
    return reply(`${n} bank transactions are not allocated yet, across the active bank accounts.`, n, [], href, label);
  }
  const total = r2(active.reduce((s, a) => s + a.balance, 0));
  const ledger = r2((await getCashBalance(companyId, today)).total);
  return reply(`Per imported bank statements the active bank accounts hold ${rand(total)}; ledger cash is ${rand(ledger)}. The two differ when statements are missing or the ledger has unmatched postings.`, total, [
    ...active.map((a) => ({ label: a.accountName, value: r2(a.balance) })),
    ...inactive.map((a) => ({ label: `${a.accountName} (inactive, not in the total)`, value: r2(a.balance) })),
    { label: 'Ledger cash (general ledger)', value: ledger },
  ], href, label);
}

async function fiscalYears(companyId: string, today: string): Promise<FiscalYears> {
  const now = await fiscalYearForDate(companyId, today);
  const prev = await fiscalYearForDate(companyId, dayBefore(now.startDate));
  return { thisStart: now.startDate, lastStart: prev.startDate, lastEnd: prev.endDate };
}

async function fiscalYearWindow(companyId: string, year: number): Promise<ResolvedPeriod | null> {
  const y = await getFiscalYear(companyId, year);
  return y ? { from: y.startDate, to: y.endDate, label: `FY${year}` } : null;
}

export async function income(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const named = intent.period?.kind;
  const fy = named === 'this_year' || named === 'last_year' ? await fiscalYears(companyId, today) : null;
  const w = intent.period?.kind === 'fy' ? await fiscalYearWindow(companyId, intent.period.year) : resolveWindow(intent.period, today, fy);
  const link = 'Open the income statement';
  if (!w) {
    return periodRefusal('this', describePeriod(intent.period), 'I understand a month, "this month", "last month", "this year", "last year" and a financial year ("FY2026").', '/accounting/reports/income-statement', link);
  }
  const r = await getIncomeStatement(companyId, w.from, w.to);
  const href = `/accounting/reports/income-statement?period_start=${w.from}&period_end=${w.to}`;
  const cos = r2(r.totalCostOfSales), opex = r2(r.totalOperatingExpenses), other = r2(r.totalOtherExpenses);
  if (intent.qualifier === 'gross') return reply(`Gross profit for ${w.label} is ${rand(r.grossProfit)}: revenue less cost of sales.`, r2(r.grossProfit),
    [{ label: 'Revenue', value: r2(r.totalRevenue) }, { label: 'Cost of sales', value: cos }], href, link);
  if (intent.qualifier === 'operating') return reply(`Operating profit for ${w.label} is ${rand(r.operatingProfit)}: before finance cost and tax.`, r2(r.operatingProfit), [], href, link);
  if (intent.qualifier === 'cost_of_sales') return reply(`Cost of sales for ${w.label} is ${rand(cos)}.`, cos, [], href, link);
  if (intent.id === 'revenue') return reply(`Revenue for ${w.label} is ${rand(r.totalRevenue)}.`, r2(r.totalRevenue), [], href, link);
  if (intent.id === 'expenses') {
    const total = r2(cos + opex + other);
    return reply(`Expenses for ${w.label} are ${rand(total)}: cost of sales, operating expenses, and finance cost and tax. Profit is revenue plus other income less these.`, total,
      [{ label: 'Cost of sales', value: cos }, { label: 'Operating expenses', value: opex }, { label: 'Other expenses (finance cost, tax)', value: other }], href, link);
  }
  return reply(`Net profit for ${w.label} is ${rand(r.netProfit)}.`, r2(r.netProfit), [
    { label: 'Revenue', value: r2(r.totalRevenue) }, { label: 'Other income', value: r2(r.totalOtherIncome) },
    { label: 'Cost of sales', value: cos }, { label: 'Operating expenses', value: opex }, { label: 'Other expenses (finance cost, tax)', value: other },
  ], href, link);
}

export async function balanceSheet(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const href = '/accounting/reports/balance-sheet';
  const label = 'Open the balance sheet';
  const at = resolveAsAt(intent.period, today);
  if (!at) return refuseAsAt(intent, today, href, label);
  const sheet = await getBalanceSheet(companyId, at.date);
  const assets = intent.id === 'assets';
  const total = r2(assets ? sheet.totalAssets : sheet.totalLiabilities);
  return reply(`Total ${assets ? 'assets' : 'liabilities'} as at ${at.label} are ${rand(total)}.`, total, [], href, label);
}
