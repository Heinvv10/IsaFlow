import {randomUUID} from 'node:crypto';
import {als} from '@/lib/als';
import {withSavepoint,type DbRow} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {BeneficiaryError,normalizeBeneficiaryDetails,type BeneficiaryDetails} from '../controls/beneficiaryValidation';
import {lockEmployeeBank} from '../controls/employeeBeneficiaryBank';
import {proposeBeneficiaryChange} from '../controls/beneficiaryService';
import {readControlEntityVersion} from '../controls/operationVersions';
import {recordCommittedChange} from '../controls/changeEventService';
import type {ControlTx,EvidenceRef} from '../controls/contracts';
export interface EmployeeBankInput {bankDetails?:BeneficiaryDetails;beneficiaryEvidenceRefs?:readonly EvidenceRef[]}
export interface EmployeeBeneficiaryReview {proposalId:string;status:'pending'}
export async function employeeWrite<T>(companyId:string,action:(ctx:ControlTx)=>Promise<T>):Promise<T>{
 try{
  const ctx=requireControlTx();if(ctx.principal.companyId!==companyId)throw new BeneficiaryError('COMPANY_MISMATCH');
  return await withSavepoint(`employee_${randomUUID().replaceAll('-','').slice(0,20)}`,async()=>{
   await assertEffectivePermission(ctx,'write:payroll');
   await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-payroll:${companyId}`},0))`;
   return action(ctx);
  });
 }catch(error){const state=als.getStore();if(state)state.controlWriteFailed=true;throw error;}
}
export async function prepareEmployeeBankChange(ctx:ControlTx,input:EmployeeBankInput,employeeId?:string):Promise<BeneficiaryDetails|null>{
 if(input.bankDetails===undefined)return null;
 const details=normalizeBeneficiaryDetails(input.bankDetails);
 if(employeeId){
  const current=await lockEmployeeBank(ctx,employeeId);
  if(current){
   try{if(JSON.stringify(normalizeBeneficiaryDetails(current))===JSON.stringify(details))return null;}
   catch(error){if(!(error instanceof BeneficiaryError))throw error;}
  }
 }
 await assertEffectivePermission(ctx,'write:beneficiaries');return details;
}
export async function finishEmployeeWrite(ctx:ControlTx,before:DbRow|null,after:DbRow,bank:BeneficiaryDetails|null,evidence:readonly EvidenceRef[]=[]):Promise<EmployeeBeneficiaryReview|null>{
 const ref={entityType:'employee' as const,entityId:String(after.id)};
 const proposal=bank?await proposeBeneficiaryChange(ctx,ref,bank,evidence):null;
 const version=await readControlEntityVersion(ctx,ref);
 await recordCommittedChange(ctx,{...ref,previousVersion:version?.version??null,newVersion:(version?.version??0)+1,
  action:before?'employee.update':'employee.create',accountingDate:null,before,after,bindingHash:null,protectedEvidenceRef:null});
 const rows=proposal?[]:await ctx.sql`SELECT id AS "proposalId",status FROM control_beneficiary_proposals
  WHERE company_id=${ctx.principal.companyId}::uuid AND entity_type='employee' AND entity_id=${ref.entityId}::uuid AND status='pending' LIMIT 1` as EmployeeBeneficiaryReview[];
 return proposal??rows[0]??null;
}
