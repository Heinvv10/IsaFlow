import { formatMoney } from '@/lib/money/formatMoney';
import { getAge } from './payeEngine';
import { accumulateComponents } from './payrollLineAccumulate';
import { costPayeWithDonations } from './payrollLinePaye';
import { calculateUIF } from './uifEngine';
import { calculateSDL } from './sdlEngine';
import { resolveEtiForEmployee } from './etiEngine';
import { sdlLeviableToDate } from './sdlLeviableCumulative';
import { remunerationBeforeDeductions } from './payrollLineRemuneration';
import { classifyEmployment, employedShareOfMonth, timeWorkedEarnings } from './employmentTerms';
import { outsideTablesResult, payeUnderTreatment, taxStatusTreatment } from './taxStatusTreatment';
import { validateEmploymentTerms } from './validationEngine';
import { hoursValidation, runHoursOf, unitOf } from './payrollRunHours';
import { etiHoursOf, ordinaryWageCents } from './etiHours';
import { nationalMinimumWageCents } from './etiTables';
import type {
  PayrollLineInput,
  PayrollLineResult,
  EtiResult,
} from './payrollTypes';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/*
 * Non-cash fringe benefits (design, Hein 2026-11-03: settle it once, end to end).
 * Today the one non-cash earning is the low-interest loan benefit, SARS 3801, which
 * appendLoanComponents injects with `isNonCash` (a cash equivalent, Seventh Schedule
 * para 11; nothing is paid). Any earning carrying `isNonCash` is treated so:
 *  - PAYE: remuneration (Fourth Schedule para 1 (a) takes in para (i) of "gross income"),
 *    so it is periodic taxable pay like cash. loadLoanComponents takes only a taxable 3801.
 *  - UIF: the component's is_uif_applicable flag, as for every earning; setup-components
 *    creates the 3801 with it off. Whether UIF's "remuneration" takes in a benefit is not
 *    settled here (no SARS/UIF source fetched): the flag is the one switch.
 *  - SDL: leviable when is_sdl_applicable (setup default on; SDL Act s3(3) is para 1
 *    remuneration), and part of the employer's s4(b) threshold basis, `remuneration`.
 *  - ETI: in "monthly remuneration" (the para 1 remuneration), as when it was paid as cash.
 *  - Cash: NOT in grossPay, so not in netPay or the journal (DR labour = gross = cash),
 *    though the PAYE on it is withheld from the cash.
 * Stored per line: gross_pay (and the header's total_gross) = cash earnings only;
 * taxable_income / periodic_taxable include the benefit; sdl is on it; the benefit itself
 * is the breakdown item flagged `isNonCash: true`. A line costed before the flag existed
 * has the benefit inside gross_pay and no flag. Readers that need remuneration rather than
 * cash add the flagged items (findOverdrawnLines leaves them out of deductions;
 * estimateAnnualRemuneration adds them to each earlier month's total_gross).
 */
export function calculatePayrollLine(input: PayrollLineInput): PayrollLineResult {
  const { employee, components, period, taxYear, annualPayrollEstimate } = input;

  const periodDate = new Date(period.year, period.month - 1, 28);
  // SARS grants the age rebates for the whole year of assessment to an
  // employee who reaches 65 / 75 on or before its last day (end of February),
  // so the rebate age is taken there, not at the pay date.
  const taxYearEnd = new Date(taxYear, 2, 0);
  const rebateAge = employee.dateOfBirth ? getAge(employee.dateOfBirth, taxYearEnd) : 30;

  const acc = accumulateComponents(components);
  const { grossPay, allEarnings, directivePaye, uifLeviable, sdlLeviable, totalDeductions, medicalSchemeFees, loanInstalments, retirementContributions, donations, breakdown, warnings } = acc;
  let { periodicTaxable, annualPayments } = acc;

  // A month counts as a periodic-remuneration period when periodic remuneration
  // was paid. Capture that before an annual-payment clawback or a taxable
  // deduction can reduce the amount taxed from the tables.
  const remuneration = remunerationBeforeDeductions(periodicTaxable, annualPayments);
  // A net negative annual payment (a bonus clawback) reduces regular pay, as it
  // did before the split. Allowed donations come off regular pay first, any
  // excess off the annual payments, so the taxed total is unchanged by the split.
  if (annualPayments < 0) {
    periodicTaxable += annualPayments;
    annualPayments = 0;
  }
  const periodicRemuneration = remuneration.periodic;
  const annualPaymentRemuneration = remuneration.annualPayment;
  // How the employee is taxed (TS-b): the tables, a flat 25% (non-standard), or none (contractor). The class reads what the line pays
  // per day (employmentTerms). A line off the tables is costed as a first period (no year to date), then replaced below; its month
  // stays out of every later table month's base.
  const timeWorked = timeWorkedEarnings(components);
  const classification = classifyEmployment(employee, taxYear, {
    earnings: timeWorked, employedShare: employedShareOfMonth(period, employee.startDate, employee.endDate),
  });
  const treatment = taxStatusTreatment(employee.taxStatus, classification.kind);
  const onTables = treatment.paye === 'tables';
  const ytdForTables = onTables ? input.ytd : undefined;

  const medicalBeneficiaries = employee.medicalAidMainMember
    ? 1 + employee.medicalAidDependantsCount
    : employee.medicalAidDependantsCount;

  // Fees deducted for a scheme the employee is not recorded as a member of: no MTC (and, 65+, no
  // additional credit) is given, so PAYE is over-deducted. Warned, not corrected: the membership is data.
  if (medicalSchemeFees > 0 && medicalBeneficiaries <= 0) {
    warnings.push({
      code: 'MEDICAL_FEES_WITHOUT_MEMBERSHIP',
      severity: 'warning',
      message: `R${medicalSchemeFees.toFixed(2)} of medical aid contributions (code 4005) is deducted, but the employee is not marked as a `
        + `medical aid member and has no dependants, so no medical tax credit${rebateAge >= 65 ? ' (nor the 65+ additional credit)' : ''} `
        + 'was given and PAYE is over-deducted. Set the medical aid membership on the employee and recalculate.',
    });
  }
  const { donation, regularTaxable, annualTaxable, regular, annualPaymentPaye, medicalCredit, additionalMedicalCredit, retirementDeduction } = costPayeWithDonations({
    periodicTaxable, annualPayments, donations,
    receiptHeld: employee.s18aReceiptHeld === true,
    payeInput: {
      periodicRemuneration, annualPaymentRemuneration,
      ytd: ytdForTables ?? { periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0 },
      taxYear, rebateAge, monthlyMedicalBeneficiaries: medicalBeneficiaries, medicalSchemeFees, retirementContributions,
    },
    ytd: ytdForTables,
  });
  warnings.push(...donation.warnings, ...validateEmploymentTerms(employee, classification, components));
  // Taxable remuneration BEFORE the retirement fund deduction, which is its own figure (retirementDeduction): a
  // line's record can exceed its pay (a catch-up contribution), and taxable_income must not go negative.
  const taxableIncome = regularTaxable + annualTaxable;
  // A directive's PAYE is SARS's instruction for a lump sum: it stands under any treatment (G21 p. 26 "Employees' tax").
  const treated = payeUnderTreatment(treatment.paye, { regular: regular.monthlyPaye, annualPayment: annualPaymentPaye }, taxableIncome - retirementDeduction);
  const payeSplit = { regular: treated.regular, annualPayment: treated.annualPayment, directive: round2(directivePaye) };
  const paye = { ...regular, monthlyPaye: round2(payeSplit.regular + payeSplit.annualPayment + payeSplit.directive) };
  if (treatment.paye !== 'tables') warnings.push(...outsideTablesResult(treatment.paye));

  const uif = employee.uifExcluded || !treatment.uif
    ? { employeeContribution: 0, employerContribution: 0, isCapped: false }
    : calculateUIF(uifLeviable, taxYear);

  // SDL is levied on SDL-applicable pay less the para 2(4) retirement and donation deductions allowed, over the tax
  // year (sdlLeviableCumulative). No other deduction reduces PAYE or SDL; the s4(b) threshold stays on gross.
  // The pay enters the cumulative maths as the cent figure the line stores (sdl_applicable), so the year to date and
  // this line work from exactly the same numbers.
  const sdlApplicable = treatment.sdl ? round2(sdlLeviable) : 0;
  const sdlLeviableAfterDeductions = treatment.sdl
    ? sdlLeviableToDate(employee.id, sdlApplicable, round2(retirementDeduction + donation.sdlDeduction), input.ytd) : 0;

  // Leviability depends on the employer's twelve-month remuneration, not on
  // this line, so a caller costing a full run defers and applies the threshold
  // once it knows that total. Charged on the cent-rounded leviable amount the
  // line stores, which is what the run pass (applySdlToLines) recomputes from.
  const sdl = annualPayrollEstimate === 'defer'
    ? 0
    : calculateSDL(sdlLeviableAfterDeductions, annualPayrollEstimate, taxYear);

  // Missing dates are reported as indeterminate, never fabricated into a
  // determination of "not eligible" — see resolveEtiForEmployee.
  // The ETI base stays the whole remuneration, annual payments, lump sums and
  // non-cash benefits included, unchanged by P3: "monthly remuneration" is the Fourth Schedule paragraph 1
  // remuneration ("salary, leave pay, wage, overtime pay, bonus, gratuity, ...")
  // paid or payable in the month (SARS Guide to the Employment Tax Incentive,
  // Issue 5, §2.4 "Monthly remuneration",
  // https://www.sars.gov.za/wp-content/uploads/Ops/Guides/LAPD-ETI-G01-Guide-to-the-Employment-Tax-Incentive.pdf).
  // ET: the hours employed and paid in the month (run hours for hourly and daily staff; hours a week x 52/12 for monthly
  // staff) apportion ETI under s7(5) and test the ordinary wage against the minimum wage (s4(1)(a)); see etiHours.ts.
  const hours = input.notEmployedInPeriod ? null : runHoursOf(employee, components);
  const etiHours = input.notEmployedInPeriod ? null : etiHoursOf(employee, period, hours);
  const resolved: EtiResult = resolveEtiForEmployee({
    dateOfBirth: employee.dateOfBirth,
    employmentStartDate: employee.startDate,
    periodDate,
    monthlyRemuneration: allEarnings,
    isUifExcluded: employee.uifExcluded,
    hours: etiHours == null ? null : { monthlyHours: etiHours, ordinaryWageCents: ordinaryWageCents(components) },
  }, taxYear);
  // A leaver paid after leaving worked no hours in the period, and ETI is
  // apportioned by hours employed and paid for out of 160 (section 7(5); same
  // guide, §2.4 and §5.3 "Employee employed for part of a month"): nil.
  const etiRaw: EtiResult = input.notEmployedInPeriod
    ? {
      ...resolved, isEligible: false, isDeterminable: true, missingInputs: [], monthlyEti: 0,
      ineligibilityReason: 'Not employed in this period (paid after leaving): ETI is apportioned by hours employed, none here.',
    }
    : !treatment.eti
      ? { ...resolved, isEligible: false, isDeterminable: true, missingInputs: [], monthlyEti: 0, ineligibilityReason: 'Independent contractor: not an employee, so no ETI.' }
      : resolved;

  // Hours that cannot be told are never taken as a full month. A monthly employee keeps the figure as before (no
  // apportionment, no minimum-wage test); an hourly or daily one, whose pay is the hours, claims none (HD's nil).
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  const hoursUnknown = !input.notEmployedInPeriod && etiHours == null && etiRaw.monthlyEti > 0;
  const byTime = unitOf(employee) != null;
  const eti: EtiResult = hoursUnknown && byTime
    ? { ...etiRaw, isEligible: false, monthlyEti: 0, ineligibilityReason: 'The hours or days worked cannot be told, so ETI cannot be apportioned by hours: none is claimed.' }
    : etiRaw;
  if (hoursUnknown) {
    warnings.push({
      code: 'ETI_HOURS_UNKNOWN', severity: 'warning',
      message: byTime
        ? `${name}'s hours or days worked this month cannot be told, so no ETI was claimed (ETI Act s7(5) apportions it by hours). Enter them and recalculate.`
        : `No ordinary hours a week are recorded for ${name}, so ETI of ${formatMoney(etiRaw.monthlyEti)} was claimed as for a full month, without `
          + 'apportioning it by hours (ETI Act s7(5)) or testing the wage against the national minimum wage (s4(1)(a)). Record the hours a week on the employee and recalculate.',
    });
  }
  if (etiHours != null && eti.monthlyEti > 0 && nationalMinimumWageCents(periodDate) == null) {
    warnings.push({
      code: 'ETI_MINIMUM_WAGE_UNKNOWN', severity: 'warning',
      message: `No national minimum wage is loaded for this period, so ${name}'s wage was not tested against it (ETI Act s4(1)(a)). Check it before claiming the ETI.`,
    });
  }

  const netPay = Math.round(
    (grossPay - totalDeductions - paye.monthlyPaye - uif.employeeContribution) * 100,
  ) / 100;

  // The run service previews loan applications through this calculation before writing them. A loan shortfall is
  // therefore a blocking decision and the stored line is rebuilt without the loan. Other deductions keep the
  // historical nil floor and approval refusal.
  if (netPay < 0) {
    const fromLoan = round2(netPay + loanInstalments) >= 0;
    // A non-cash benefit is taxed but not paid: its PAYE comes out of the cash, which may be why.
    const nonCash = round2(allEarnings - grossPay);
    const benefitNote = nonCash > 0 ? ` PAYE includes the tax on ${formatMoney(nonCash)} of non-cash benefits, which are taxed but not paid.` : '';
    warnings.push(fromLoan ? {
      code: 'LOAN_INSTALMENT_EXCEEDS_PAY',
      severity: 'error',
      rawNet: netPay,
      message: `The loan instalment is ${formatMoney(-netPay)} above available pay. This payslip is blocked for manual review.${benefitNote}`,
    } : {
      code: 'DEDUCTIONS_EXCEED_PAY',
      severity: 'error',
      rawNet: netPay,
      message: `Deductions and tax come to ${formatMoney(-netPay)} more than this employee's pay, so net pay shows as nil and `
        + `the deductions payable are understated by that amount.${benefitNote} Reduce the deductions, then recalculate.`,
    });
  }

  return {
    employeeId: employee.id,
    grossPay: Math.round(grossPay * 100) / 100,
    remuneration: round2(allEarnings),
    taxableIncome: Math.round(taxableIncome * 100) / 100,
    periodicTaxable: round2(regularTaxable),
    annualTaxable: round2(annualTaxable),
    periodicRemuneration: round2(periodicRemuneration),
    annualPaymentRemuneration: round2(annualPaymentRemuneration),
    paye,
    payeSplit,
    medicalCredit: onTables ? medicalCredit : 0,
    additionalMedicalCredit: onTables ? additionalMedicalCredit : 0,
    medicalSchemeFees: round2(medicalSchemeFees),
    retirementContributions: round2(retirementContributions),
    retirementDeduction,
    uif,
    sdl: Math.round(sdl * 100) / 100,
    sdlLeviable: sdlLeviableAfterDeductions,
    sdlApplicable,
    donationReceipted: donation.receipted,
    donationBase: donation.base,
    donationDeduction: donation.deduction,
    eti,
    netPay: Math.max(0, netPay),
    componentBreakdown: breakdown,
    validationResults: [...warnings, ...(input.notEmployedInPeriod ? [] : hoursValidation(employee, components))],
    hours,
  };
}
