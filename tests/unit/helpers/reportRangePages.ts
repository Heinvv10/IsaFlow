// The auto-loading report pages with a From and a To: where each sends its range, and a report whose visible text
// is `marker`, so a test can tell which request is on screen. Pages are loaded through reportDateGatePages.ts.
export interface RangePage {
  file: string;
  /** The report requests one run sends. The first is the one a test counts. */
  paths: string[];
  fromParam: string;
  toParam: string;
  data: (marker: string) => unknown;
  /** Report-derived text outside the report body: it must go when the report goes. */
  summary?: RegExp;
  /** Report-derived notice outside the report body, by test id. */
  notice?: string;
}

const PERIOD = { fromParam: 'period_start', toParam: 'period_end' };
const FROM_TO = { fromParam: 'from', toParam: 'to' };
const UNCLASSIFIED = { accounts: 1, amount: 10, message: 'One account is unclassified.' };
const kpis = {
  revenue: 1, netProfit: 0, cashBalance: 0, revenueGrowth: 0, profitGrowth: 0, grossProfitMargin: 1, netProfitMargin: 1,
  currentRatio: 1, debtToEquity: 0, notMeaningful: {},
};
const cashPosition = { cashBalance: 0, accountsReceivable: 0, accountsPayable: 0, netWorkingCapital: 0, currentRatio: 1 };
const totals = { opening_balance: 0, inflows: 1, outflows: 0, net_movement: 1, closing_balance: 1 };
const cashFlow = { operatingCashFlow: 0, investingCashFlow: 0, financingCashFlow: 0, netCashFlow: 0, openingCash: 0, closingCash: 0 };

export const RANGE_PAGES: RangePage[] = [
  { file: 'audit-trail', paths: ['reports-audit-trail'], ...PERIOD, summary: /^1 entries$/,
    data: (m) => [{ entryDate: '2026-04-01', entryNumber: m, description: 'd', source: 'manual', status: 'posted', totalDebit: 1, totalCredit: 1, createdBy: 'x', createdAt: '2026-04-01', postedAt: null }] },
  { file: 'cash-movement', paths: ['reports/cash-movement'], ...FROM_TO,
    data: (m) => ({ from: '2026-04-01', to: '2026-04-30', accounts: [{ account_id: 'a', account_name: m, account_number: null, ...totals }], totals }) },
  { file: 'customer-reports', paths: ['reports-customer?'], ...PERIOD,
    data: (m) => [{ clientId: 'c', clientName: m, invoiceCount: 1, totalInvoiced: 1, totalPaid: 0, balance: 1 }] },
  { file: 'executive-dashboard', paths: ['reports-executive-summary', 'reports-kpi-scorecard'], ...FROM_TO, notice: 'data-quality-notice',
    data: (m) => ({ summary: { period: 'p', companyName: 'Co', kpis, cashPosition, highlights: [{ type: 'neutral', message: m }], alerts: [] },
      scorecard: [], unclassifiedAccounts: UNCLASSIFIED }) },
  { file: 'general-ledger', paths: ['reports-general-ledger'], ...PERIOD, summary: /with activity in this period/,
    data: (m) => ({ accounts: [{ accountCode: '1000', accountName: m, accountType: 'asset', openingBalance: 0, closingBalance: 1, totalDebit: 1, totalCredit: 0, transactions: [] }] }) },
  { file: 'item-movement', paths: ['reports/item-movement'], ...FROM_TO,
    data: (m) => [{ date: '2026-04-01', type: 'GRN', reference: m, itemCode: 'I', itemName: 'Item', qtyIn: 1, qtyOut: 0, balance: 1 }] },
  { file: 'management-accounts', paths: ['reports-management-accounts'], ...PERIOD,
    data: (m) => ({ companyName: 'Co', periodStart: '2026-04-01', periodEnd: '2026-04-30', generatedAt: '2026-04-30T00:00:00Z', kpis: {},
      incomeStatement: { subtypeDisclosure: { notices: [m] } }, balanceSheet: {}, cashFlow }) },
  { file: 'project-profitability', paths: ['reports-project-profitability'], ...PERIOD,
    data: (m) => [{ projectId: 'p', projectName: m, revenue: 1, costs: 0, profit: 1, margin: 100, revenueLines: [], costLines: [] }] },
  { file: 'purchases-by-item', paths: ['reports/purchases-by-item'], ...FROM_TO,
    data: (m) => [{ id: 'i', itemCode: 'I', name: m, category: 'C', poCount: 1, qtyOrdered: 1, totalCost: 1, avgCost: 1 }] },
  { file: 'purchases-by-supplier', paths: ['reports/purchases-by-supplier'], ...FROM_TO,
    data: (m) => [{ supplierId: 's', supplierName: m, invoiceCount: 1, totalPurchases: 1, paymentsMade: 0, outstanding: 1 }] },
  { file: 'report-packs', paths: ['reports-pack'], ...FROM_TO, notice: 'data-quality-notice',
    data: (m) => ({ pack: { type: 'board', companyName: 'Co', period: m, generatedAt: '2026-04-30T00:00:00Z', sections: [] }, unclassifiedAccounts: UNCLASSIFIED }) },
  { file: 'sales-by-customer', paths: ['reports/sales-by-customer'], ...FROM_TO,
    data: (m) => [{ clientId: 'c', clientName: m, invoiceCount: 1, totalSales: 1, paymentsReceived: 0, outstanding: 1 }] },
  { file: 'sales-by-item', paths: ['reports/sales-by-item'], ...FROM_TO,
    data: (m) => [{ id: 'i', itemCode: 'I', name: m, category: 'C', timesSold: 1, qtySold: 1, totalRevenue: 1, avgPrice: 1 }] },
  { file: 'supplier-reports', paths: ['reports-supplier?'], ...PERIOD,
    data: (m) => [{ supplierId: 's', supplierName: m, invoiceCount: 1, totalInvoiced: 1, totalPaid: 0, balance: 1 }] },
  { file: 'vat-reconciliation', paths: ['api/accounting/vat-reconciliation'], ...FROM_TO,
    data: (m) => ({ issues: [{ month: '2026-04', severity: 'warning', message: m }], months: [], totals: {}, summary: [] }) },
];
