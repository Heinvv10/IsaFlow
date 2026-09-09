import type {ControlTx} from '../controls/contracts';
import {assertControlledEffectPermit} from '../controls/approvalExecutionService';
import {readControlEntityVersion} from '../controls/operationVersions';
import {recordCommittedChange} from '../controls/changeEventService';
import {lockArInvoiceSources} from '../controls/arSourceMaterial';
import type {ArParentControl} from './customerInvoiceFinancialEffect';
/** Child invoice balance facts share the parent operation, transaction and immutable evidence. */
export async function mutateArInvoiceBalance(ctx:ControlTx,id:string,parentControl:ArParentControl,action:string,mutation:()=>Promise<unknown>){
 assertControlledEffectPermit(ctx,parentControl.permit,parentControl.parent);
 const before=await lockArInvoiceSources(ctx,id);
 const prior=await readControlEntityVersion(ctx,{entityType:'customer_invoice',entityId:id});
 const version=prior?.version??1;
 if(!prior){await recordCommittedChange(ctx,{entityType:'customer_invoice',entityId:id,previousVersion:0,newVersion:1,action:'baseline_observed',accountingDate:parentControl.permit.accountingDate,before:null,after:before,bindingHash:null,protectedEvidenceRef:null,operationId:parentControl.permit.operationId});}
 await mutation();
 const after=await lockArInvoiceSources(ctx,id);
 await recordCommittedChange(ctx,{entityType:'customer_invoice',entityId:id,previousVersion:version,newVersion:version+1,action,accountingDate:parentControl.permit.accountingDate,before,after,bindingHash:null,protectedEvidenceRef:null,operationId:parentControl.permit.operationId});
}
