/** Types of the VAT reconciliation report (split from vatReconciliationService). */

// ── Types ───────────────────────────────────────────────────────────────────

export interface VatReconMonth {
  month: string;                // YYYY-MM
  // GL-based
  glRevenue: number;            // Total revenue from GL (account_type = 'revenue')
  glOutputVat: number;          // VAT Output balance from GL journals
  glInputVat: number;           // VAT Input balance from GL journals
  glNetVat: number;             // Output - Input
  // Invoice-based
  invoiceRevenue: number;       // Customer invoice totals
  invoiceOutputVat: number;     // Customer invoice VAT
  invoiceInputVat: number;      // Supplier invoice VAT
  // Submitted returns
  returnOutputVat: number | null; // The VAT201 filed (vatPeriodFilings: version, else legacy vat_returns); null = none
  returnInputVat: number | null;
  returnNetVat: number | null;
  returnStatus: string | null;  // 'finalised' | 'filed' (lifecycle), 'submitted' (legacy) | null
  // Capital goods split
  capitalGoodsOutput: number;
  capitalGoodsInput: number;
  otherGoodsOutput: number;
  otherGoodsInput: number;
  // Variances
  revenueVariance: number;      // GL revenue - Invoice revenue
  outputVatVariance: number;    // GL output VAT - Return output VAT
  inputVatVariance: number;     // GL input VAT - Return input VAT
  effectiveVatRate: number;     // GL output VAT / GL revenue (should be ~15%)
}

export interface VatReconciliation {
  companyId: string;
  periodStart: string;
  periodEnd: string;
  months: VatReconMonth[];
  totals: {
    glRevenue: number;
    glOutputVat: number;
    glInputVat: number;
    glNetVat: number;
    invoiceRevenue: number;
    returnNetVat: number;
    capitalGoodsOutput: number;
    capitalGoodsInput: number;
    revenueVariance: number;
    outputVatVariance: number;
    inputVatVariance: number;
  };
  issues: VatReconIssue[];
}

export interface VatReconIssue {
  month: string;
  severity: 'warning' | 'error';
  message: string;
}
