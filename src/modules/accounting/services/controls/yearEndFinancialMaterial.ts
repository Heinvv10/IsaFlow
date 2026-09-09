import Decimal from 'decimal.js';
import { fmtDate } from '@/lib/fmtDate';
import { buildExactClosingPlan } from '../gl/glBypassExactPlans';
import { resolveFiscalYearStartMonth } from '../gl/fiscalYearBasis';
import { fiscalYearRange } from '../gl/fiscalYearCalendar';
import { canonicalMoney } from './canonical';
import { deriveJournalAmount } from './glOperationMaterializer';
import type { ControlTx } from './contracts';
type Row = Record<string, unknown>;
const D = Decimal.clone({ precision: 80 });
export interface YearClosingSources { company: Row; periods: Row[]; journals: Row[]; lines: Row[]; accounts: Row[] }
const date = (value: unknown) => value instanceof Date ? fmtDate(value) : String(value).slice(0, 10);

/** Uses the same locked journal population as period evidence, rather than a second unlocked P&L report. */
export async function buildYearEndFinancialMaterial(ctx: ControlTx, year: string, source: YearClosingSources) {
  const { company, periods, journals, lines, accounts } = source;
  const currency = company.default_currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Closing ledger currency unavailable');
  const expected = fiscalYearRange(Number(year), resolveFiscalYearStartMonth(company.financial_year_start, ctx.principal.companyId));
  const starts = periods.map(p => date(p.start_date)).sort(), ends = periods.map(p => date(p.end_date)).sort();
  if (starts[0] !== expected.startDate || ends.at(-1) !== expected.endDate) throw new Error('Fiscal year period range mismatch');
  const retainedRows = await ctx.sql`SELECT id,account_code,account_name,account_type,account_subtype,is_active
    FROM gl_accounts WHERE company_id=${ctx.principal.companyId}::uuid AND is_system_account=true
      AND account_subtype='retained_earnings' ORDER BY id LIMIT 2 FOR SHARE` as Row[];
  if (retainedRows.length !== 1 || retainedRows[0]!.account_type !== 'equity') throw new Error('Retained earnings role missing or ambiguous');
  const retained = retainedRows[0]!;
  const posted = new Set(journals.filter(j => j.status === 'posted').map(j => String(j.id)));
  const profitAccounts = accounts.filter(a => a.account_type === 'revenue' || a.account_type === 'expense');
  const ids = new Set(profitAccounts.map(a => String(a.id)));
  const balances = new Map<string, Decimal>();
  for (const line of lines) {
    const id = String(line.gl_account_id);
    if (!posted.has(String(line.journal_entry_id)) || !ids.has(id)) continue;
    if (typeof line.debit !== 'string' || typeof line.credit !== 'string') throw new Error('Closing monetary source is not decimal text');
    balances.set(id, (balances.get(id) ?? new D(0)).add(canonicalMoney(line.debit)).sub(canonicalMoney(line.credit)));
  }
  const accountBalances = profitAccounts.map(a => ({ id: String(a.id), balance: (balances.get(String(a.id)) ?? new D(0)).toFixed() }));
  const plan = buildExactClosingPlan(accountBalances, String(retained.id));
  const netIncome = accountBalances.reduce((sum, a) => sum.sub(a.balance), new D(0));
  return { amount: plan.length ? deriveJournalAmount(plan) : '0', currency, netIncome: canonicalMoney(netIncome.toFixed()),
    accountingDate: expected.endDate, retained, accountBalances, plan };
}
