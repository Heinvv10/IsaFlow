import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlCheckResult,ControlTx} from './contracts';
import {checkDuplicateInvoices} from './duplicateInvoiceChecks';
import {checkPaymentRisks} from './paymentRiskChecks';
import {checkThreeWayMatchExceptions} from './threeWayMatchChecks';
import {checkJournalRisks} from './journalRiskChecks';
import {checkPayrollControls} from './payrollControlChecks';
import {checkBankStatementCompleteness} from './bankStatementCompletenessChecks';
import {parseExceptionCheck,type ExceptionCheckId} from './controlExceptionTypes';
const checkers={duplicate_invoice_checks:checkDuplicateInvoices,payment_risk_checks:checkPaymentRisks,
 three_way_match_exceptions:checkThreeWayMatchExceptions,journal_risk_checks:checkJournalRisks,bank_statement_completeness:checkBankStatementCompleteness,payroll_control_checks:checkPayrollControls};
export async function assertExceptionReadPermission(ctx:ControlTx,checkId:ExceptionCheckId){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:reports');
 if(checkId==='payroll_control_checks')await assertEffectivePermission(ctx,'read:payroll');
 // Apply the detector's complete read ceiling even when only retained findings are read.
 if(checkId==='duplicate_invoice_checks'||checkId==='payment_risk_checks'||checkId==='three_way_match_exceptions')await assertEffectivePermission(ctx,'read:invoices');
 if(checkId==='payment_risk_checks'||checkId==='bank_statement_completeness')await assertEffectivePermission(ctx,'read:bank-tx');
 if(checkId==='payment_risk_checks')await assertEffectivePermission(ctx,'write:bank-tx');
}
/** The dispatch table is closed; transport cannot provide a result, callback or evidence. */
export async function runExceptionCheck(ctx:ControlTx,input:unknown):Promise<ControlCheckResult>{
 const {checkId,...options}=parseExceptionCheck(input);await assertExceptionReadPermission(ctx,checkId);
 return checkers[checkId](ctx,{...options,limit:options.limit??100});
}
