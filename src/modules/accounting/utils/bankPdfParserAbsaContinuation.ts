/**
 * Bank PDF Parser — which lines of an ABSA slash-date statement are NOT a continuation of the row above them.
 * Extracted from bankPdfParserAbsa.ts for file-size compliance; behaviour unchanged.
 */

export const ignoreContinuation = (line: string): boolean => {
  if (!line) return true;
  if (/^\(Effective\s/i.test(line)) return true;
  if (/^(Balance Brought Forward|Sundry (Credits|Debits)|Charges|Total (Debits|Credits))/i.test(line)) return true;
  if (/^Page\s+\d+/i.test(line)) return true;
  if (/^(Classic Business Acc|Cheque account statement|Statement Number)/i.test(line)) return true;
  if (/^BRIGHTSPHERE|BLITZ|VELOCITY/i.test(line)) return true;
  if (/^(Return address|Reg No|Absa Bank Limited)/i.test(line)) return true;
  if (/^\d{4,}$/.test(line)) return true;
  return false;
};

const BOUNDARY_MARKERS = [
  /-{2,}\s*\d+\s+of\s+\d+\s*-{2,}/i,
  /Page\s+\d+\s+of\s+\d+/i,
  /Tax Invoice/i,
  /Your transactions/i,
  /Cheque Account Number/i,
  /Date\s+Transaction\s+Description/i,
  /Authorised Financial Services Provider/i,
  /Registration Number\s+\d{4}/i,
  /^CSP\d+|BFIBRE\s+\d+/i,
  /YOUR PRICING PLAN/i,
  /CREDIT INTEREST RATE/i,
  /PRICING PLAN/i,
  /CHARGE LEGEND/i,
  /VAT REGISTRATION/i,
  /NCRCP\d/i,
  /^\d{2}-\d{4}-\d{4}\b/,
  /SERVICE FEE:/i,
  /MNTHLY ACCT FEE/i,
  /Sms Notifications?/i,
  /^CHARGES\s/i,
] as const;

export const isPageBoundary = (line: string): boolean =>
  BOUNDARY_MARKERS.some(re => re.test(line));
