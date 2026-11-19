/**
 * A VAT201 payment reference number for a golden's company (wave 6 EFa): its own 10-digit VAT number (the filing route
 * refuses a PRN of another number, FILING_REFERENCE_TAX_NUMBER), a letter and 8 digits that differ each run (one PRN
 * names one period's return). A company with no 10-digit VAT number recorded gets a placeholder number.
 */
export function vatPrn(company: Record<string, unknown>): string {
  const recorded = String(company.vatNumber ?? company.vat_number ?? '').replace(/\D/g, '');
  const number = /^4\d{9}$/.test(recorded) ? recorded : '4123456789';
  return `${number}V${String(Date.now() % 1e8).padStart(8, '0')}`;
}
