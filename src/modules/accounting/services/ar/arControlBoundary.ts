import {requireControlTx} from '../controls/context';
import {executeControlledOperation,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import type {OperationRef} from '../controls/contracts';
import {readArInvoicePostingReceipt} from './arPostingReceipt';
export interface ArApprovalOptions {approvalId?:string}
export class ArApprovalRequiredError extends Error{
 readonly code='OPERATION_APPROVAL_REQUIRED';readonly statusCode=409;
 constructor(readonly operation:OperationRef['operation'],readonly entityId:string){super('Independent operation approval is required. Request approval before retrying.');this.name='ArApprovalRequiredError';}
}
export function requireArControl(companyId:string,userId:string){
 const ctx=requireControlTx();if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Control transaction actor does not match AR operation');return ctx;
}
/** The caller supplies an approval identifier; the kernel loads material, policy and current authority. */
export async function runArControlled<T>(companyId:string,userId:string,ref:OperationRef,opts:ArApprovalOptions|undefined,effect:(permit:ControlledEffectPermit)=>Promise<T>):Promise<T>{
 const ctx=requireArControl(companyId,userId);
 if(ref.operation==='customer_invoice.post'&&!opts?.approvalId){
  const existing=await readArInvoicePostingReceipt(ctx,ref.entityId);if(existing)return existing as T;
 }
 try{return await executeControlledOperation(ctx,ref,opts?.approvalId??null,async permit=>JSON.parse(JSON.stringify(await effect(permit))) as T);}
 catch(error){if(error instanceof Error&&error.message==='Independent operation approval is required')throw new ArApprovalRequiredError(ref.operation,ref.entityId);throw error;}
}
