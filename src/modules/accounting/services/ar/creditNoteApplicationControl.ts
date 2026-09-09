import {randomUUID} from 'node:crypto';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireArControl} from './arControlBoundary';
import {lockArCreditSources} from '../controls/arCreditMaterial';
import {lockArInvoiceSources} from '../controls/arSourceMaterial';
/** Preparation is explicit and durable, so independent approval can bind the exact target. */
export async function prepareCreditNoteApplication(companyId:string,creditNoteId:string,invoiceId:string,userId:string,applicationId?:string){
 const ctx=requireArControl(companyId,userId);
 await assertEffectivePermission(ctx,'write:invoices');
 const {header}=await lockArCreditSources(ctx,creditNoteId);
 const {header:invoice}=await lockArInvoiceSources(ctx,invoiceId);
 if(header.type!=='customer'||invoice.owned_customer_id!==header.client_id)throw new Error('Invoice and credit note must belong to the same customer');
 if(applicationId){
  const rows=await ctx.sql`SELECT id FROM control_credit_note_applications WHERE company_id=${companyId}::uuid AND id=${applicationId}::uuid
   AND credit_note_id=${creditNoteId}::uuid AND customer_invoice_id=${invoiceId}::uuid`;
  if(rows.length!==1)throw new Error('Credit application target does not match');
 }else{
  const rows=await ctx.sql`SELECT id FROM control_credit_note_applications WHERE company_id=${companyId}::uuid
   AND credit_note_id=${creditNoteId}::uuid AND customer_invoice_id=${invoiceId}::uuid ORDER BY created_at,id LIMIT 1` as Array<{id:string}>;
  applicationId=rows[0]?.id;
  if(!applicationId){
   if(header.status!=='approved')throw new Error('Credit note must be approved before applying');
   applicationId=randomUUID();
   await ctx.sql`INSERT INTO control_credit_note_applications(company_id,id,credit_note_id,customer_invoice_id,requester_person_id)
    VALUES(${companyId}::uuid,${applicationId}::uuid,${creditNoteId}::uuid,${invoiceId}::uuid,${userId})`;
  }
 }
 return {entityType:'credit_note_application',entityId:applicationId,operation:'credit_note_application.apply'} as const;
}
