/**
 * Employees, monthly pay runs and payroll journals (PLAN 5.6). Every figure
 * comes from the app's own pure engine (calculatePayrollLine, the tax tables
 * and applySdlToLines): nothing here holds a rate or a bracket. A tax year the
 * engine has no tables for throws UnsupportedTaxYearError and aborts the run.
 *
 * Paid runs for every completed window month; one draft run in the current
 * month; nothing later. The journal mirrors payrollJournalBuilder's lines and
 * entry date (last day of the month, net pay straight to the bank); PAYE, UIF
 * and SDL leave the bank on the 7th of the next month when that day has passed.
 */

import { calculatePayrollLine } from '../../../src/modules/accounting/services/payroll/payrollCalculator';
import { applySdlToLines, type SdlLine } from '../../../src/modules/accounting/services/payroll/sdlLeviabilityService';
import { getTaxYear, getTaxYearConfig } from '../../../src/modules/accounting/services/payroll/taxTables';
import type { PayeYearToDate, PayrollEmployee, PayrollLineResult } from '../../../src/modules/accounting/services/payroll/payrollTypes';
import { addMonths, at0900, dayOf, monthEnd, monthLabel, monthStart } from './dates';
import { EMPLOYEES, buildInvalidSaId, dateOfBirth, placeholderTaxNumber, placeholderUifNumber, startDate } from './employees';
import { between, money, toCents, uuidFrom } from './rng';
import type { Ctx } from './types';

const localDate = (iso: string): Date => new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));

function emptyYtd(): PayeYearToDate {
  return {
    periods: 0, retirementCapPeriods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0,
    additionalMedicalCredit: 0, medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0, donations: 0,
    sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0, sdlDonationDeduction: 0,
  };
}

function addToYtd(y: PayeYearToDate, l: PayrollLineResult, sdlExempt: boolean): void {
  y.periods += l.periodicTaxable > 0 ? 1 : 0;
  y.retirementCapPeriods = (y.retirementCapPeriods ?? 0) + (l.periodicTaxable > 0 || l.annualTaxable > 0 ? 1 : 0);
  y.periodicTaxable += l.periodicTaxable;
  y.annualPayments += l.annualTaxable;
  y.tablePaye += l.payeSplit.regular + l.payeSplit.annualPayment;
  if (!sdlExempt) {
    y.sdlApplicable = (y.sdlApplicable ?? 0) + l.sdlApplicable;
    y.sdlLeviable = (y.sdlLeviable ?? 0) + l.sdlLeviable;
  }
}

export function generatePayroll(ctx: Ctx): void {
  const { companyId, actorId, payroll } = ctx.input;
  const { today, months, windowStart } = ctx.win;
  const people = EMPLOYEES.map((e, i) => {
    const dob = dateOfBirth(today, e, i);
    const start = startDate(windowStart, e);
    const idNumber = buildInvalidSaId(dob, (e.gender === 'female' ? 100 : 5100) + i);
    const emp: PayrollEmployee = {
      id: e.id, companyId, employeeNumber: e.number, firstName: e.firstName, lastName: e.lastName, idNumber,
      taxNumber: placeholderTaxNumber(i), employmentType: 'permanent', startDate: localDate(start), dateOfBirth: localDate(dob),
      uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld: false,
      paymentMethod: 'eft', taxStatus: 'employee', payBasis: 'monthly', payFrequency: 'monthly', occupation: e.occupation,
    };
    ctx.rows.payroll_employees.push({
      id: e.id, company_id: companyId, employee_number: e.number, first_name: e.firstName, last_name: e.lastName,
      id_number: idNumber, tax_number: placeholderTaxNumber(i), uif_number: placeholderUifNumber(i), employment_type: 'permanent',
      start_date: start, date_of_birth: dob, equity_gender: e.gender, department: e.department, status: 'active',
      payment_method: 'eft', tax_status: 'employee', pay_basis: 'monthly', pay_frequency: 'monthly', occupation: e.occupation,
    });
    ctx.rows.payroll_employee_components.push({
      id: uuidFrom(ctx.rng), employee_id: e.id, component_id: payroll.basicComponent.id, amount: money(e.salary * 100),
      effective_from: start, is_recurring: true,
    });
    return { fx: e, emp, start };
  });

  const ytd = new Map<string, PayeYearToDate>();
  let ytdYear = -1;
  const history: Array<{ idx: number; remuneration: number }> = [];
  for (const { year, month } of months.slice(0, -1)) {
    const end = monthEnd(year, month);
    const active = people.filter((p) => p.start <= end);
    if (active.length === 0) continue;
    const taxYear = getTaxYear(month, year);
    getTaxYearConfig(taxYear);
    if (taxYear !== ytdYear) { ytd.clear(); ytdYear = taxYear; }
    const results = active.map((p) => calculatePayrollLine({
      employee: p.emp, components: [{ component: payroll.basicComponent, amount: p.fx.salary }], period: { month, year },
      taxYear, annualPayrollEstimate: 'defer', ytd: ytd.get(p.emp.id),
    }));
    // The employer's SDL basis, as estimateAnnualRemuneration takes it: the trailing year of runs, this one included.
    const idx = year * 12 + month;
    const remuneration = results.reduce((s, r) => s + r.remuneration, 0);
    const prior = history.filter((h) => h.idx >= idx - 11 && h.idx < idx);
    const first = history.length === 0 ? idx : history[0]!.idx;
    const elapsed = prior.length === 0 ? 1 : Math.min(12, Math.max(1, idx - first + 1));
    const annual = Math.round(((prior.reduce((s, h) => s + h.remuneration, 0) + remuneration) / elapsed) * 12 * 100) / 100;
    history.push({ idx, remuneration });
    const sdlLines: SdlLine[] = results.map((r) => ({ sdl: 0, sdlLeviable: r.sdlLeviable, explanation: r.explanations }));
    applySdlToLines(sdlLines, annual, taxYear);
    writeRun(ctx, { year, month, results, sdlLines });
    results.forEach((r, i) => {
      const y = ytd.get(r.employeeId) ?? emptyYtd();
      addToYtd(y, r, sdlLines[i]!.sdlExempt === true);
      ytd.set(r.employeeId, y);
    });
  }
  const cur = months[months.length - 1]!;
  ctx.rows.payroll_run_headers.push({
    id: uuidFrom(ctx.rng), company_id: companyId, period_month: cur.month, period_year: cur.year, status: 'draft',
    pay_frequency: 'monthly', run_kind: 'regular', period_start: monthStart(cur.year, cur.month), period_end: monthEnd(cur.year, cur.month),
    created_by: actorId,
  });
  for (const p of people) {
    for (const lt of payroll.leaveTypes) {
      const monthsThisYear = Number(ctx.win.lastMonthEnd.slice(0, 4)) === Number(today.slice(0, 4)) ? Number(ctx.win.lastMonthEnd.slice(5, 7)) : 0;
      const accrued = Math.round(lt.accrualDays * monthsThisYear * 100) / 100;
      const taken = between(ctx.rng, 0, Math.floor(accrued)) / 2;
      ctx.rows.payroll_leave_balances.push({
        id: uuidFrom(ctx.rng), employee_id: p.fx.id, company_id: companyId, leave_type_id: lt.id, balance_year: Number(today.slice(0, 4)),
        accrued, taken, pending: 0,
      });
    }
  }
}

function writeRun(ctx: Ctx, run: { year: number; month: number; results: PayrollLineResult[]; sdlLines: SdlLine[] }): void {
  const { companyId, actorId, accounts } = ctx.input;
  const { year, month, results, sdlLines } = run;
  const end = monthEnd(year, month);
  const c = { gross: 0, taxable: 0, paye: 0, uifEe: 0, uifEr: 0, sdl: 0, net: 0 };
  const runId = uuidFrom(ctx.rng);
  results.forEach((r, i) => {
    const gross = toCents(r.grossPay); const paye = toCents(r.paye.monthlyPaye); const uifEe = toCents(r.uif.employeeContribution);
    const net = toCents(r.netPay); const sdl = toCents(sdlLines[i]!.sdl);
    if (gross !== paye + uifEe + net) throw new Error(`payroll line for ${r.employeeId} ${year}-${month} does not foot`);
    c.gross += gross; c.taxable += toCents(r.taxableIncome); c.paye += paye; c.uifEe += uifEe;
    c.uifEr += toCents(r.uif.employerContribution); c.sdl += sdl; c.net += net;
    ctx.rows.payroll_run_lines.push({
      id: uuidFrom(ctx.rng), run_id: runId, employee_id: r.employeeId, gross_pay: money(gross), taxable_income: money(toCents(r.taxableIncome)),
      periodic_taxable: money(toCents(r.periodicTaxable)), annual_taxable: money(toCents(r.annualTaxable)), paye: money(paye),
      medical_credit: money(toCents(r.medicalCredit)), additional_medical_credit: money(toCents(r.additionalMedicalCredit)),
      medical_scheme_fees: money(toCents(r.medicalSchemeFees)), retirement_contributions: money(toCents(r.retirementContributions)),
      retirement_deduction: money(toCents(r.retirementDeduction)), uif_employee: money(uifEe), uif_employer: money(toCents(r.uif.employerContribution)),
      sdl: money(sdl), sdl_leviable: money(toCents(r.sdlLeviable)), sdl_applicable: money(toCents(r.sdlApplicable)),
      sdl_exempt: sdlLines[i]!.sdlExempt === true, donation_receipted: money(toCents(r.donationReceipted)),
      donation_base: money(toCents(r.donationBase)), donation_deduction: money(toCents(r.donationDeduction)),
      eti: money(toCents(r.eti.monthlyEti)), net_pay: money(net), explanation: JSON.stringify(sdlLines[i]!.explanation ?? r.explanations),
      component_breakdown: JSON.stringify(r.componentBreakdown), validation_results: JSON.stringify(r.validationResults),
    });
  });
  const mm = String(month).padStart(2, '0');
  const label = monthLabel(year, month).toUpperCase();
  const entry = ctx.jb.add({
    date: end, description: `Payroll run ${year}-${mm}`, reference: `PAY-${year}-${mm}`, source: 'auto_payroll',
    bankText: `SALARIES ${label}`,
    lines: [
      { accountId: accounts.labour, debit: c.gross + c.uifEr + c.sdl, credit: 0, description: 'Labour costs: gross pay and employer UIF and SDL' },
      { accountId: accounts.paye, debit: 0, credit: c.paye, description: 'PAYE payable' },
      { accountId: accounts.uif, debit: 0, credit: c.uifEe + c.uifEr, description: 'UIF payable (employee + employer)' },
      { accountId: accounts.sdl, debit: 0, credit: c.sdl, description: 'SDL payable' },
      { accountId: accounts.bank, debit: 0, credit: c.net, description: 'Net salaries paid' },
    ],
  });
  const stamp = at0900(end);
  ctx.rows.payroll_run_headers.push({
    id: runId, company_id: companyId, period_month: month, period_year: year, status: 'paid', run_date: end,
    total_gross: money(c.gross), total_taxable: money(c.taxable), total_paye: money(c.paye), total_uif: money(c.uifEe + c.uifEr),
    total_sdl: money(c.sdl), total_eti: money(0), total_net: money(c.net), employee_count: results.length,
    created_by: actorId, prepared_by: actorId, calculated_at: stamp, approved_by: actorId, approved_at: stamp,
    approval_grandfathered_at: stamp, journal_entry_id: entry.id, pay_frequency: 'monthly', run_kind: 'regular',
    period_start: monthStart(year, month), period_end: end,
  });
  const next = addMonths(year, month, 1);
  const payDay = dayOf(next.year, next.month, 7);
  if (payDay <= ctx.win.today) {
    ctx.jb.add({
      date: payDay, description: `PAYE, UIF and SDL for ${monthLabel(year, month)}`, reference: `STAT-${year}-${mm}`, source: 'manual',
      bankText: `PAYE UIF SDL payment ${label}`,
      lines: [
        { accountId: accounts.paye, debit: c.paye, credit: 0, description: 'PAYE paid' },
        { accountId: accounts.uif, debit: c.uifEe + c.uifEr, credit: 0, description: 'UIF paid' },
        { accountId: accounts.sdl, debit: c.sdl, credit: 0, description: 'SDL paid' },
        { accountId: accounts.bank, debit: 0, credit: c.paye + c.uifEe + c.uifEr + c.sdl, description: 'Statutory payment' },
      ],
    });
  }
}
