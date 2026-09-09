import type { PayrollRunSummary } from './payrollRunService';
import { executePayrollPost, type PayrollControlOptions } from './payrollControlService';
export interface ApprovePayrollRunResult extends PayrollRunSummary { journalEntryId: string }
/** Approval and direct posting share one operation identity and one atomic financial effect. */
export async function approvePayrollRun(companyId:string,runId:string,userId:string,opts?:PayrollControlOptions):Promise<ApprovePayrollRunResult> {
  const result=await executePayrollPost(companyId,runId,userId,opts);
  return {...result.run,journalEntryId:result.journalEntryId};
}
