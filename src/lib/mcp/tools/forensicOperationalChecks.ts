import {riskTool} from './forensicRiskChecks';
import {checkThreeWayMatchExceptions} from '@/modules/accounting/services/controls/threeWayMatchChecks';
import {checkJournalRisks} from '@/modules/accounting/services/controls/journalRiskChecks';
import {checkBankStatementCompleteness} from '@/modules/accounting/services/controls/bankStatementCompletenessChecks';
import {checkPayrollControls} from '@/modules/accounting/services/controls/payrollControlChecks';

export const threeWayMatchExceptionsTool=riskTool('three_way_match_exceptions',
 'Checks owned purchase-order invoice lines against cumulative accepted receipts and invoice quantities, prices and recorded tolerances. '
 +'Requires current report and invoice read permissions. Returns complete finding totals before pagination; missing receipts or unsupported source populations remain unknown. '
 +'Uses the same matching calculation as invoice controls. This read does not approve overrides or persist exceptions.',checkThreeWayMatchExceptions);
export const journalRiskChecksTool=riskTool('journal_risk_checks',
 'Checks posted journals for actual-time versus accounting-date differences, reversals, current thresholds and recorded period-state changes. '
 +'Requires current report read permission. Results are investigation leads, not fraud conclusions; unavailable historical timing or period evidence remains explicit. '
 +'Finding totals cover the supported population before pagination; oversized populations remain unknown.',checkJournalRisks);
export const bankStatementCompletenessTool=riskTool('bank_statement_completeness',
 'Compares imported bank populations with independently retained statement counts, periods and balances. '
 +'Requires current report and bank-transaction read permissions. Missing or unverified independent source evidence remains unknown; '
 +'transaction-free days do not prove missing data and no detected gap does not prove completeness. Reads do not attest statements.',checkBankStatementCompleteness);
export const payrollControlChecksTool=riskTool('payroll_control_checks',
 'Checks owned payroll totals, liabilities and settlement records, beneficiary reuse candidates, recorded component changes, terminated employees paid and zero-cost employees. '
 +'Requires current report and payroll read permissions. Exact totals precede finding pagination; unavailable source evidence or external settlement confirmation remains unknown. '
 +'Sensitive payroll results are restricted by shared current authority.',checkPayrollControls);
export const operationalCheckTools=[threeWayMatchExceptionsTool,journalRiskChecksTool,bankStatementCompletenessTool,payrollControlChecksTool] as const;
