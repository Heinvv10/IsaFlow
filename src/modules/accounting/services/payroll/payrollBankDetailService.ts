import {employeeWrite,type EmployeeBeneficiaryReview} from './payrollEmployeeWriteBoundary';
import {proposeBeneficiaryChange,getVerifiedBeneficiary} from '../controls/beneficiaryService';
import {assertControlTx} from '../controls/context';
import type {BeneficiaryDetails} from '../controls/beneficiaryValidation';
import type {ControlTx,EvidenceRef} from '../controls/contracts';
/** Maintenance adapter: never overwrites an active row, including when called by a future bulk/import adapter. */
export async function proposePayrollBankDetails(companyId:string,employeeId:string,details:BeneficiaryDetails,evidence:readonly EvidenceRef[]=[]):Promise<EmployeeBeneficiaryReview>{
 return employeeWrite(companyId,async ctx=>{
  return proposeBeneficiaryChange(ctx,{entityType:'employee',entityId:employeeId},details,evidence);
 });
}
/** INTERNAL payment executor selector. No legacy employee fallback or generic response projection is permitted. */
export async function getVerifiedPayrollBankDetails(ctx:ControlTx,employeeId:string){
 assertControlTx(ctx);return getVerifiedBeneficiary(ctx,{entityType:'employee',entityId:employeeId});
}
