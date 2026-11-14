/** "Ask IsaFlow" tax and payroll figures: VAT201, EMP201 and the latest pay run. */
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { getDeclarablePayRun } from '@/modules/accounting/services/payroll/payrollRunQueryService';
import { getCompanyVatCycle, type VatCycle } from '@/modules/accounting/services/reports/companyVatCycle';
import { defaultVatQuickPeriod } from '@/modules/bureau/services/vatPeriodHelper';
import type { AskIntent } from './askIntents';
import { describePeriod, isMonthWindow, monthOf, MONTH_NAMES } from './askPeriod';
import { periodRefusal, rand, reply, type AskAnswer } from './askTypes';

const r2 = (n: number): number => Math.round(n * 100) / 100;
const pad = (n: number): string => String(n).padStart(2, '0');
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** The VAT period (the company's own cycle) containing `date`. */
function periodContaining(s: VatCycle, date: string) {
  return defaultVatQuickPeriod(s.cadence, s.alignment, new Date(`${date}T00:00:00Z`));
}

export async function vat(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const href = '/accounting/sars/vat201';
  const label = 'Open the VAT201';
  const p = intent.period;
  if (!isMonthWindow(p)) {
    return periodRefusal('VAT', describePeriod(p), 'VAT is filed by VAT period. Name a month, "this month" or "last month", or leave the period out for your current one.', href, label);
  }
  const settings = await getCompanyVatCycle(companyId);
  if (!settings) return reply('This company is not set up as a VAT vendor, so there is no VAT201.', null, [], href, label);
  // No window, "this month" and "this/current period" all mean the company's current VAT period.
  const t = p && p.kind !== 'this_month' ? monthOf(p, today, 'this') : null;
  const asked = t ? ymd(t.y, t.m, 1) : today;
  const period = periodContaining(settings, asked);
  const { totals } = await getVat201Report(companyId, period.from, period.to, { detail: 'summary' });
  const net = r2(totals.netVat);
  const what = net >= 0 ? `${rand(net)} payable to SARS` : `${rand(-net)} refundable`;
  const note = t ? ` ${MONTH_NAMES[t.m - 1]} ${t.y} falls in this VAT period; the figure is for the whole period.` : ` This is your current VAT period (${period.from}\u2013${period.to}).`;
  return reply(`VAT for ${period.label} (${period.from} to ${period.to}): ${what}.${note}`, net,
    [{ label: 'Output tax', value: r2(totals.outputTax) }, { label: 'Input tax', value: r2(totals.inputTax) }],
    `${href}?from=${period.from}&to=${period.to}`, label);
}

export async function emp201(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const href = '/accounting/sars/emp201';
  const label = 'Open the EMP201';
  const p = intent.period;
  if (!isMonthWindow(p)) {
    return periodRefusal('the EMP201', describePeriod(p), 'An EMP201 is one month. Name a month, "this month" or "last month", or leave it out for last month.', href, label);
  }
  const t = monthOf(p, today, 'last')!;
  const from = ymd(t.y, t.m, 1);
  const to = ymd(t.y, t.m, lastDay(t.y, t.m));
  const d = await generateEMP201(companyId, from, to);
  const total = r2(d.totalDeductions);
  return reply(`The EMP201 for ${MONTH_NAMES[t.m - 1]} ${t.y} comes to ${rand(total)} (PAYE after ETI, UIF and SDL).`, total,
    [{ label: 'PAYE payable', value: r2(d.payePayable) }, { label: 'UIF', value: r2(d.totalUIF) }, { label: 'SDL', value: r2(d.totalSDL) }],
    `${href}?from=${from}&to=${to}`, label);
}

/** The run EMP201 would declare for the month, or the latest such. Which runs count is payrollRunQueryService's. */
export async function lastPayRun(intent: AskIntent, companyId: string, today: string): Promise<AskAnswer> {
  const href = '/payroll/runs';
  const p = intent.period;
  if (!isMonthWindow(p)) {
    return periodRefusal('a pay run', describePeriod(p), 'Name a month, "this month" or "last month", or leave it out for the latest run.', href, 'Open pay runs');
  }
  const t = p ? monthOf(p, today, 'this') : null;
  const run = await getDeclarablePayRun(companyId, t ? { year: t.y, month: t.m } : null);
  if (!run) return reply(t ? `There is no approved or paid pay run for ${MONTH_NAMES[t.m - 1]} ${t.y}.` : 'There are no approved or paid pay runs yet.', null, [], href, 'Open pay runs');
  return reply(`The ${t ? '' : 'latest '}pay run for ${run.periodYear}-${pad(run.periodMonth)} (${run.status}) has gross pay of ${rand(run.totalGross)} and net pay of ${rand(run.totalNet)}.`,
    r2(run.totalGross), [{ label: 'Net pay', value: r2(run.totalNet) }, { label: 'PAYE', value: r2(run.totalPaye) }], `/payroll/runs/${run.id}`, 'Open the pay run');
}
