/**
 * An independent contractor on the e@syFile certificate (TS-b). Income "reflects under code 3616", never 3601 (the employee's
 * gross salary): PAYE-GEN-01-G21 (2027) Rev 1 p. 26 "IRP5/IT3(a) details". IsaFlow takes no PAYE from a contractor
 * (taxStatusTreatment), so the certificate is an IT3(a) with 4150 = 03, which the BRS lists for exactly this case:
 * SARS PAYE Employer Reconciliation BRS V25.3.0 p. 109, "03 or 3 = Independent contractor or Directors fees for RSA resident
 * NED", and p. 62, "Value 3 or 03 is only valid if code 3616/3666 has been completed or code 3620/3670 has been completed".
 * Whatever the amount: the threshold reasons (02, 04) and nilTaxReason, which refuses a whole file for pay over the
 * threshold with no tax, do not apply. A contractor with PAYE withheld (a directive, or tax taken before the status was
 * set) gets an IRP5 with the income under 3616 and no 4150.
 */
export interface ContractorFilingInput {
  taxStatus: string;
  /** The certificate's salary income as the run lines give it (what would be 3601). */
  salaryIncome: number;
}

/** The income to file under 3616 for a contractor; null for everyone else (filed as before). */
export function contractorIncome3616(i: ContractorFilingInput): number | null {
  return i.taxStatus === 'independent_contractor' ? i.salaryIncome : null;
}

/** 4150 for a contractor's certificate with no tax (BRS V25.3.0 p. 109). */
export const CONTRACTOR_NON_DEDUCTION_REASON = '03';
