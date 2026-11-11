import { formatMoney } from '@/lib/money/formatMoney';
import { getAge } from './payeEngine';
import { accumulateComponents } from './payrollLineAccumulate';
import { costPayeWithDonations } from './payrollLinePaye';
import { uifWithLeviable } from './uifEngine';
import { calculateSDL, isSdlExempt } from './sdlEngine';
import { resolveEtiForEmployee } from './etiEngine';
import { sdlLeviableTrace } from './sdlLeviableCumulative';
import { explainPayrollLine } from './payrollExplain';
import { remunerationBeforeDeductions } from './payrollLineRemuneration';
import { classifyEmployment, employedShareOfMonth, timeWorkedEarnings } from './employmentTerms';
import { outsideTablesResult, payeUnderTreatment, taxStatusTreatment } from './taxStatusTreatment';
import { validateEmploymentTerms } from './validationEngine';
import { etiHoursPending, hoursValidation, runHoursOf } from './payrollRunHours';
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
  const { grossPay, allEarnings, directivePaye, uifLeviable, sdlLeviable, totalDeductions, medicalSchemeFees, loanInstalments, retirementContributions, donations, breakdown, warnings, periodicParts } = acc;
  let { periodicTaxable, annualPayments } = acc;

  // A month counts as a periodic-remuneration period when periodic remuneration
  // was paid. Capture that before an annual-payment clawback or a taxable
  // deduction can reduce the amount taxed from the tables.
  const remuneration = remunerationBeforeDeductions(periodicTaxable, annualPayments);
  // A net negative annual payment (a bonus clawback) reduces regular pay, as it
  // did before the split. Allowed donations come off regular pay first, any
  // excess off the annual payments, so the taxed total is unchanged by the split.
  const clawback = Math.min(0, annualPayments);
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
  const { donation, regularTaxable, annualTaxable, regular, annualPaymentPaye, medicalCredit, additionalMedicalCredit, retirementDeduction, trace, donationOffAnnual } = costPayeWithDonations({
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
  const balanceOfRemuneration = taxableIncome - retirementDeduction;
  // A directive's PAYE is SARS's instruction for a lump sum: it stands under any treatment (G21 p. 26 "Employees' tax").
  const treated = payeUnderTreatment(treatment.paye, { regular: regular.monthlyPaye, annualPayment: annualPaymentPaye }, balanceOfRemuneration);
  const payeSplit = { regular: treated.regular, annualPayment: treated.annualPayment, directive: round2(directivePaye) };
  const paye = { ...regular, monthlyPaye: round2(payeSplit.regular + payeSplit.annualPayment + payeSplit.directive) };
  if (treatment.paye !== 'tables') warnings.push(...outsideTablesResult(treatment.paye));

  const uifCosted = employee.uifExcluded || !treatment.uif ? null : uifWithLeviable(uifLeviable, taxYear);
  const uif = uifCosted?.uif ?? { employeeContribution: 0, employerContribution: 0, isCapped: false };

  // SDL is levied on SDL-applicable pay less the para 2(4) retirement and donation deductions allowed, over the tax
  // year (sdlLeviableCumulative). No other deduction reduces PAYE or SDL; the s4(b) threshold stays on gross.
  // The pay enters the cumulative maths as the cent figure the line stores (sdl_applicable), so the year to date and
  // this line work from exactly the same numbers.
  const sdlApplicable = treatment.sdl ? round2(sdlLeviable) : 0;
  const sdlDeduction = round2(retirementDeduction + donation.sdlDeduction);
  const sdlTrace = treatment.sdl ? sdlLeviableTrace(employee.id, sdlApplicable, sdlDeduction, input.ytd) : null;
  const sdlLeviableAfterDeductions = sdlTrace?.leviable ?? 0;

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
  const resolved: EtiResult = resolveEtiForEmployee({
    dateOfBirth: employee.dateOfBirth,
    employmentStartDate: employee.startDate,
    periodDate,
    monthlyRemuneration: allEarnings,
    isUifExcluded: employee.uifExcluded,
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

  // HD: ETI is apportioned by hours out of 160 and ET (not yet built) will do it from the stored quantity. Until then an
  // hourly or daily line under a full month's hours, or with hours that cannot be told, claims none.
  const hours = input.notEmployedInPeriod ? null : runHoursOf(employee, components);
  const etiPending = !input.notEmployedInPeriod && etiHoursPending(employee, hours) && etiRaw.monthlyEti > 0;
  const eti: EtiResult = etiPending
    ? { ...etiRaw, isEligible: false, monthlyEti: 0, ineligibilityReason: 'Hourly or daily pay under 160 hours: ETI apportionment by hours is not built yet, so none is claimed.' }
    : etiRaw;
  if (etiPending) {
    warnings.push({
      code: 'ETI_HOURS_APPORTIONMENT_PENDING', severity: 'warning',
      message: `${employee.firstName} ${employee.lastName} is paid by the ${employee.payBasis === 'hourly' ? 'hour' : 'day'} and worked under 160 hours (or the hours cannot be told), `
        + 'so no ETI was claimed: ETI apportioned by hours is not built yet. Claim it on the EMP201 by hand if due.',
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

  // "How was this calculated?" (EX-core): the figures above, arranged; payrollExplain computes none of them.
  const explanations = explainPayrollLine({
    taxYear, periodDate,
    paye: {
      treatment: treatment.paye, classification, periodicParts, clawback, periodicBeforeDonation: periodicTaxable, annualBeforeDonation: annualPayments,
      donationDeduction: donation.deduction, donationOffAnnual,
      trace, retirementRecorded: retirementDeduction, balanceOfRemuneration, split: payeSplit, paye: paye.monthlyPaye,
    },
    uif: {
      uif, leviable: uifCosted?.leviable ?? null, uifRemuneration: uifLeviable,
      outsideReason: !treatment.uif ? 'Independent contractor: no UIF' : employee.uifExcluded ? 'The employee is excluded from UIF' : null,
    },
    sdl: {
      outsideReason: treatment.sdl ? null : 'Independent contractor: no SDL', sdlApplicable, trace: sdlTrace,
      deduction: sdlDeduction, retirementDeduction, donationDeduction: donation.sdlDeduction,
      charge: annualPayrollEstimate === 'defer' ? 'deferred'
        : { annualRemuneration: annualPayrollEstimate, exempt: isSdlExempt(annualPayrollEstimate, taxYear), sdl },
    },
    eti: { eti },
  });

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
    explanations,
  };
}
