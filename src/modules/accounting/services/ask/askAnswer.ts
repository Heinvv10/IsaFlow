/**
 * "Ask IsaFlow" answers (wave 5 M11). Each intent calls the read-only service its MCP tool wraps, so the figure
 * is the one the tool and the page show. Nothing here writes, and every call takes the session's company id.
 */
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getFinancialFigures } from '@/modules/accounting/services/gl/financialFiguresService';
import { getBalanceSheet } from '@/modules/accounting/services/reports/balanceSheetService';
import { getFiscalYearStartMonth, DEFAULT_FY_START_MONTH } from '@/modules/accounting/services/gl/fiscalYearBasis';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { listPayRunsPage } from '@/modules/accounting/services/payroll/payrollRunQueryService';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';
import { rand, type AskAnswer, type AskLine } from './askTypes';
import { parseIntent, INTENT_EXAMPLES, type AskIntent } from './askIntents';
import { resolvePeriod } from './askPeriod';

const r2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

const reply = (text: string, figure: number | null, lines: AskLine[], href: string, label: string): AskAnswer =>
  ({ understood: true, text, figure, lines, link: { href, label }, suggestions: [] });

export const NOT_UNDERSTOOD: AskAnswer = {
  understood: false,
  text: 'I can only answer a fixed set of questions, and this is not one of them. Try one of these:',
  figure: null, lines: [], link: null, suggestions: INTENT_EXAMPLES.map((i) => i.example),
};

async function aging(side: 'ar' | 'ap', companyId: string, today: string): Promise<AskAnswer> {
  const rows: AgingBucket[] = side === 'ar' ? await getARAging(companyId, today) : await getAPAging(companyId, today);
  const total = r2(rows.reduce((s, b) => s + num(b.total), 0));
  const top = [...rows].sort((a, b) => num(b.total) - num(a.total)).slice(0, 3).filter((b) => num(b.total) !== 0);
  const head = side === 'ar' ? 'Customers owe you' : 'You owe suppliers';
  return reply(`${head} ${rand(total)} across ${rows.length} ${side === 'ar' ? 'customers' : 'suppliers'}.`, total,
    top.map((b) => ({ label: b.entityName, value: r2(num(b.total)) })),
    side === 'ar' ? '/accounting/ar-aging' : '/accounting/ap-aging', side === 'ar' ? 'Open AR aging' : 'Open AP aging');
}

async function figures(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const fy = intent.period?.kind === 'this_year'
    ? await getFiscalYearStartMonth(companyId, { fallback: DEFAULT_FY_START_MONTH }) : DEFAULT_FY_START_MONTH;
  const p = resolvePeriod(intent.period, today, 'month_to_date', fy);
  const f = await getFinancialFigures(companyId, p.from, p.to);
  const href = `/accounting/reports/income-statement?period_start=${p.from}&period_end=${p.to}`;
  const link = 'Open the income statement';
  if (intent.id === 'revenue') return reply(`Revenue for ${p.label} is ${rand(f.period.revenue)}.`, r2(f.period.revenue), [], href, link);
  if (intent.id === 'expenses') {
    const total = r2(f.period.costOfSales + f.period.operatingExpenses);
    return reply(`Cost of sales and operating expenses for ${p.label} are ${rand(total)}.`, total,
      [{ label: 'Cost of sales', value: r2(f.period.costOfSales) }, { label: 'Operating expenses', value: r2(f.period.operatingExpenses) }], href, link);
  }
  return reply(`Net profit for ${p.label} is ${rand(f.period.netProfit)}.`, r2(f.period.netProfit), [], href, link);
}

async function balanceSheet(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const sheet = await getBalanceSheet(companyId, today);
  const assets = intent.id === 'assets';
  const total = r2(assets ? sheet.totalAssets : sheet.totalLiabilities);
  return reply(`Total ${assets ? 'assets' : 'liabilities'} as at ${today} are ${rand(total)}.`, total, [],
    '/accounting/reports/balance-sheet', 'Open the balance sheet');
}

async function vat(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const p = resolvePeriod(intent.period, today, 'month_to_date', DEFAULT_FY_START_MONTH);
  const { totals } = await getVat201Report(companyId, p.from, p.to, { detail: 'summary' });
  const net = r2(totals.netVat);
  return reply(`VAT for ${p.label}: ${net >= 0 ? `${rand(net)} payable to SARS` : `${rand(-net)} refundable`}. This is the period you named, not a filed VAT period.`,
    net, [{ label: 'Output tax', value: r2(totals.outputTax) }, { label: 'Input tax', value: r2(totals.inputTax) }],
    '/accounting/sars/vat201', 'Open the VAT201');
}

async function emp201(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const p = resolvePeriod(intent.period, today, 'last_month', DEFAULT_FY_START_MONTH);
  const d = await generateEMP201(companyId, p.from, p.to);
  const total = r2(d.payePayable + d.totalUIF + d.totalSDL);
  return reply(`The EMP201 for ${p.label} comes to ${rand(total)} (PAYE after ETI, UIF and SDL).`, total,
    [{ label: 'PAYE payable', value: r2(d.payePayable) }, { label: 'UIF', value: r2(d.totalUIF) }, { label: 'SDL', value: r2(d.totalSDL) }],
    '/payroll/compliance', 'Open payroll compliance');
}

async function lastPayRun(companyId: string): Promise<AskAnswer> {
  const page = await listPayRunsPage(companyId, { limit: 1 });
  const run = page.rows[0];
  if (!run) return reply('There are no pay runs yet.', null, [], '/payroll/runs', 'Open pay runs');
  return reply(`The latest pay run (${run.periodYear}-${String(run.periodMonth).padStart(2, '0')}, ${run.status}) has gross pay of ${rand(run.totalGross)} and net pay of ${rand(run.totalNet)}.`,
    r2(run.totalGross), [{ label: 'Net pay', value: r2(run.totalNet) }, { label: 'PAYE', value: r2(run.totalPaye) }], `/payroll/runs/${run.id}`, 'Open the pay run');
}

async function bank(intent: AskIntent, companyId: string): Promise<AskAnswer> {
  const accounts = await getBankAccountsStatus(companyId, { includeInactive: true });
  if (intent.id === 'bank_to_allocate') {
    const n = accounts.reduce((s, a) => s + a.unallocatedCount, 0);
    return reply(`${n} bank transactions are not allocated yet.`, n, [], '/accounting/bank-transactions', 'Open bank transactions');
  }
  const total = r2(accounts.reduce((s, a) => s + a.balance, 0));
  return reply(`The bank accounts hold ${rand(total)} in total, from their bank transactions (the ledger's cash figure can differ).`, total,
    accounts.map((a) => ({ label: a.isActive === false ? `${a.accountName} (inactive)` : a.accountName, value: r2(a.balance) })), '/accounting/bank-accounts', 'Open bank accounts');
}

/** Answers `question` for `companyId`. `today` is the South African date (YYYY-MM-DD). */
export async function answerQuestion(companyId: string, question: string, today: string): Promise<AskAnswer> {
  const intent = parseIntent(question);
  if (!intent) return NOT_UNDERSTOOD;
  switch (intent.id) {
    case 'owed_to_me': return aging('ar', companyId, today);
    case 'i_owe': return aging('ap', companyId, today);
    case 'cash': case 'bank_to_allocate': return bank(intent, companyId);
    case 'profit': case 'revenue': case 'expenses': return figures(intent, companyId, today);
    case 'assets': case 'liabilities': return balanceSheet(intent, companyId, today);
    case 'vat': return vat(intent, companyId, today);
    case 'emp201': return emp201(intent, companyId, today);
    case 'last_pay_run': return lastPayRun(companyId);
  }
}
