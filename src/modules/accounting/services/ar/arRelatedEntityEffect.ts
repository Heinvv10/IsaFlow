import type {ControlTx} from '../controls/contracts';
import {assertControlledEffectPermit} from '../controls/approvalExecutionService';
import {readControlEntityVersion} from '../controls/operationVersions';
import {recordCommittedChange} from '../controls/changeEventService';
import {lockArInvoiceSources} from '../controls/arSourceMaterial';
import type {ArParentControl} from './customerInvoiceFinancialEffect';
type RelatedEntity='customer_invoice'|'supplier_invoice'|'credit_note'|'recurring_invoice';
async function read(ctx:ControlTx,entityType:RelatedEntity,id:string):Promise<Record<string,unknown>>{
 if(entityType==='customer_invoice')return lockArInvoiceSources(ctx,id);
 const rows=entityType==='supplier_invoice'
  ?await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid FOR UPDATE`
  :entityType==='recurring_invoice'?await ctx.sql`SELECT * FROM recurring_invoices WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid FOR UPDATE`
  :await ctx.sql`SELECT * FROM credit_notes WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid FOR UPDATE`;
 if(rows.length!==1)throw new Error('Related accounting document not found');
 return rows[0] as Record<string,unknown>;
}
/** Register each independently mutable child with the same committed operation. */
export async function mutateArRelatedEntity<T>(ctx:ControlTx,entityType:RelatedEntity,id:string,parentControl:ArParentControl,action:string,mutation:()=>Promise<T>):Promise<T>{
 assertControlledEffectPermit(ctx,parentControl.permit,parentControl.parent);
 const before=await read(ctx,entityType,id);
 const prior=await readControlEntityVersion(ctx,{entityType,entityId:id}),version=prior?.version??1;
 const common={entityType,entityId:id,accountingDate:parentControl.permit.accountingDate,bindingHash:null,protectedEvidenceRef:null,operationId:parentControl.permit.operationId};
 if(!prior)await recordCommittedChange(ctx,{...common,previousVersion:0,newVersion:1,action:'baseline_observed',before:null,after:before});
 const result=await mutation();
 await recordCommittedChange(ctx,{...common,previousVersion:version,newVersion:version+1,action,before,after:await read(ctx,entityType,id)});
 return result;
}
