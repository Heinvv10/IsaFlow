/**
 * Financial Reporting Service — Facade
 * Re-exports from incomeStatementService, balanceSheetService,
 * vatReturnService, and projectProfitabilityService
 * for backward compatibility.
 */

export { getIncomeStatement } from './incomeStatementService';
export { getBalanceSheet } from './balanceSheetService';
export { getVATReturn } from './vatReturnService';
export { getProjectProfitability } from './projectProfitabilityService';
