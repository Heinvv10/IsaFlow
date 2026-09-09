import { executePayrollPost, executePayrollReopen, type PayrollControlOptions } from './payrollControlService';
/** Both payroll entrypoints use the same bound operation; generated GL children consume its live permit. */
export async function postPayrollRunJournal(companyId:string,runId:string,userId:string,opts?:PayrollControlOptions):Promise<string> {
  return (await executePayrollPost(companyId,runId,userId,opts)).journalEntryId;
}
export async function reversePayrollRunJournal(companyId:string,runId:string,userId:string,opts?:PayrollControlOptions):Promise<string> {
  return (await executePayrollReopen(companyId,runId,userId,opts)).reversalId;
}
