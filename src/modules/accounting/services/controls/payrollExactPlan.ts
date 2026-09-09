import Decimal from 'decimal.js';
import { canonicalMoney } from './canonical';
import { deriveJournalAmount } from './glOperationMaterializer';
type Row = Record<string, unknown>;
const Money = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
const money = (value: unknown): Decimal => {
  if (typeof value !== 'string') throw new Error('Payroll money must be persisted decimal text');
  const result = new Money(canonicalMoney(value));
  if (result.isNegative()) throw new Error('Negative payroll amount');
  return result;
};
export interface ExactPayrollLine { glAccountId: string; debit: string; credit: string; description: string }
/** Preserve the legacy ledger formula, but reconcile every total and distribute residual cents exactly. */
export function buildExactPayrollPlan(header: Row, runLines: readonly Row[], accounts: readonly Row[],
  employees: readonly Row[], allocations: readonly Row[], mappings: readonly Row[]): { amount: string; lines: ExactPayrollLine[] } {
  if (!runLines.length || runLines.length > 10000 || Number(header.employee_count) !== runLines.length) throw new Error('Payroll run population is incomplete');
  const totals: Record<string, Decimal> = {};
  for (const [key, column] of Object.entries({ gross: 'gross_pay', paye: 'paye', sdl: 'sdl', eti: 'eti', net: 'net_pay' })) {
    const sum = runLines.reduce((total, row) => total.add(money(row[column])), new Money(0));
    if (!sum.eq(money(header[`total_${key}`]))) throw new Error('Payroll totals do not reconcile to employee lines');
    totals[key] = sum;
  }
  const employeeUif = runLines.reduce((sum, row) => sum.add(money(row.uif_employee)), new Money(0));
  const employerUif = runLines.reduce((sum, row) => sum.add(money(row.uif_employer)), new Money(0));
  const uif = money(header.total_uif);
  if (!employeeUif.add(employerUif).eq(uif)) throw new Error('Payroll UIF does not reconcile');
  const labour = totals.gross!.add(employerUif).add(totals.sdl!).sub(totals.eti!);
  const deductions = totals.gross!.sub(totals.paye!).sub(employeeUif).sub(totals.net!);
  if (labour.lte(0) || deductions.lt(0)) throw new Error('Payroll money is invalid');
  const accountFor = (code: string): string => {
    const found = accounts.filter(row => row.account_code === code);
    if (found.length !== 1 || found[0]!.is_active !== true) throw new Error('Payroll account is missing, ambiguous or inactive');
    return String(found[0]!.id);
  };
  const fallback = accountFor('5200');
  const buckets = new Map<string, Decimal>();
  const add = (id: string, amount: Decimal) => buckets.set(id, (buckets.get(id) ?? new Money(0)).add(amount));
  const accountByCentre = new Map<string, string>();
  for (const mapping of mappings) {
    const centre = String(mapping.cost_centre_id);
    if (accountByCentre.has(centre)) throw new Error('Ambiguous payroll cost-centre mapping');
    accountByCentre.set(centre, String(mapping.expense_account_id));
  }
  let distributed = new Money(0);
  const ordered = [...runLines].sort((a,b) => String(a.employee_id) < String(b.employee_id) ? -1 : String(a.employee_id) > String(b.employee_id) ? 1 : 0);
  for (const [index, row] of ordered.entries()) {
    const share = index === ordered.length - 1 ? labour.sub(distributed)
      : labour.mul(money(row.gross_pay)).div(totals.gross!).toDecimalPlaces(2);
    distributed = distributed.add(share);
    const splits = allocations.filter(a => a.employee_id === row.employee_id)
      .sort((a,b) => String(a.cost_centre_id) < String(b.cost_centre_id) ? -1 : String(a.cost_centre_id) > String(b.cost_centre_id) ? 1 : 0);
    if (!splits.length) {
      const employee = employees.find(e => e.id === row.employee_id);
      add(accountByCentre.get(String(employee?.cost_centre_id)) ?? fallback, share);
    } else {
      const percentage = splits.reduce((sum, a) => sum.add(money(a.percentage)), new Money(0));
      if (!percentage.eq(100)) throw new Error('Payroll cost allocation must sum to 100 percent');
      let assigned = new Money(0);
      for (const [i, split] of splits.entries()) {
        const amount = i === splits.length - 1 ? share.sub(assigned) : share.mul(money(split.percentage)).div(100).toDecimalPlaces(2);
        assigned = assigned.add(amount); add(accountByCentre.get(String(split.cost_centre_id)) ?? fallback, amount);
      }
    }
  }
  const lines: ExactPayrollLine[] = [...buckets].sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0)
    .filter(([,amount])=>!amount.isZero()).map(([id,amount])=>({glAccountId:id,debit:amount.toFixed(),credit:'0',description:'Payroll labour costs'}));
  for (const [code, amount] of [['2140',totals.paye!],['2150',uif],['2160',totals.sdl!],['1110',totals.net!],['2175',deductions]] as const) {
    if (!amount.isZero()) lines.push({glAccountId:accountFor(code),debit:'0',credit:amount.toFixed(),description:'Payroll liabilities and net pay'});
  }
  for (const line of lines) if (!accounts.some(a=>a.id === line.glAccountId && a.is_active === true)) throw new Error('Payroll account is missing or inactive');
  return { amount: deriveJournalAmount(lines), lines };
}
