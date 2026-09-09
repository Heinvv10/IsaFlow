import Decimal from 'decimal.js';
import {als} from '@/lib/als';
import {withSavepoint} from '@/lib/neon';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {recordCommittedChange} from '../controls/changeEventService';
import {readControlEntityVersion} from '../controls/operationVersions';
import {getVerifiedBeneficiary} from '../controls/beneficiaryService';
import type {ControlTx} from '../controls/contracts';
import type {BatchPaymentCreateInput} from '../../types/ap.types';
import {validateBatchInput} from './batchPaymentValidation';
import {prepareSupplierPayment} from './paymentPreparationService';
export async function batchWrite<T>(companyId:string,userId:string|undefined,action:(ctx:ControlTx)=>Promise<T>):Promise<T>{
 try{
  const ctx=requireControlTx();if(ctx.principal.companyId!==companyId||(userId!==undefined&&userId!==ctx.principal.personId))throw new Error('Batch actor does not match authenticated transaction');
  await assertEffectivePermission(ctx,'write:bank-tx');
  return await withSavepoint('controlled_batch_write',()=>action(ctx));
 }catch(error){const store=als.getStore();if(store)store.controlWriteFailed=true;throw error;}
}
export async function recordBatchEntity(ctx:ControlTx,entityType:string,before:Record<string,unknown>|null,after:Record<string,unknown>,action:string){
 const entityId=String(after.id),version=await readControlEntityVersion(ctx,{entityType,entityId});
 await recordCommittedChange(ctx,{entityType,entityId,previousVersion:version?.version??null,newVersion:(version?.version??0)+1,
  action,accountingDate:null,before,after,bindingHash:null,protectedEvidenceRef:null});
}
export async function createControlledBatch(companyId:string,input:BatchPaymentCreateInput,userId:string):Promise<string>{
 const normalized=validateBatchInput(input);
 return batchWrite(companyId,userId,async ctx=>{
  const [clock]=await ctx.sql`SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day` as Array<{day:string}>;
  const date=input.batchDate??clock?.day;if(!date)throw new Error('Batch date unavailable');
  if(input.bankAccountId){
   const accounts=await ctx.sql`SELECT id FROM gl_accounts WHERE company_id=${companyId}::uuid AND id=${input.bankAccountId}::uuid
    AND is_active=true AND account_type='asset' FOR SHARE`;
   if(accounts.length!==1)throw new Error('Owned active bank account required');
  }
  for(const payment of normalized.payments){
   await getVerifiedBeneficiary(ctx,{entityType:'supplier',entityId:payment.supplierId});
   for(const allocation of payment.allocations){
    const [invoice]=await ctx.sql`SELECT id,total_amount::text,amount_paid::text,currency,status FROM supplier_invoices
     WHERE company_id=${companyId}::uuid AND id=${allocation.invoiceId}::uuid AND supplier_id=${payment.supplierId}::uuid FOR UPDATE` as Array<{
      id:string;total_amount:string;amount_paid:string;currency:string;status:string}>;
    if(!invoice||invoice.currency!=='ZAR'||!['approved','posted','partially_paid'].includes(invoice.status))throw new Error('Owned payable ZAR invoice required');
    const [pending]=await ctx.sql`SELECT COALESCE(sum(pa.amount_allocated),0)::text AS amount FROM payment_allocations pa
     JOIN supplier_payments sp ON sp.id=pa.payment_id WHERE sp.company_id=${companyId}::uuid
      AND pa.invoice_id=${allocation.invoiceId}::uuid AND sp.status IN ('draft','approved')` as Array<{amount:string}>;
    if(new Decimal(invoice.amount_paid).add(pending?.amount??'0').add(allocation.amount).gt(invoice.total_amount))throw new Error('Batch allocation exceeds available invoice balance');
   }
  }
  const [batch]=await ctx.sql`INSERT INTO supplier_payment_batches(company_id,batch_date,payment_method,bank_account_id,notes,payment_count,total_amount,created_by)
   VALUES(${companyId}::uuid,${date}::date,'eft',${input.bankAccountId??null}::uuid,${input.notes??null},${normalized.payments.length},${normalized.total}::numeric,${ctx.principal.personId}::uuid)
   RETURNING *` as Record<string,unknown>[];
  if(!batch)throw new Error('Batch insert failed');
  for(const payment of normalized.payments){
   const [row]=await ctx.sql`INSERT INTO supplier_payments(company_id,supplier_id,payment_date,total_amount,payment_method,bank_account_id,status,batch_id,created_by)
    VALUES(${companyId}::uuid,${payment.supplierId}::uuid,${date}::date,${payment.amount}::numeric,'eft',${input.bankAccountId??null}::uuid,'draft',${String(batch.id)}::uuid,${ctx.principal.personId}::uuid) RETURNING *` as Record<string,unknown>[];
   if(!row)throw new Error('Batch payment insert failed');
   for(const allocation of payment.allocations)await ctx.sql`INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated)
    SELECT sp.id,si.id,${allocation.amount}::numeric FROM supplier_payments sp JOIN supplier_invoices si ON si.company_id=sp.company_id AND si.supplier_id=sp.supplier_id
    WHERE sp.company_id=${companyId}::uuid AND sp.id=${String(row.id)}::uuid AND si.id=${allocation.invoiceId}::uuid`;
   await prepareSupplierPayment(ctx,String(row.id));
   await recordBatchEntity(ctx,'supplier_payment',null,row,'supplier_payment.create');
  }
  await recordBatchEntity(ctx,'supplier_payment_batch',null,batch,'supplier_payment_batch.create');return String(batch.id);
 });
}
export async function changeBatchStatus(companyId:string,id:string,userId:string|undefined,status:'approved'|'cancelled'){
 return batchWrite(companyId,userId,async ctx=>{
  const [before]=await ctx.sql`SELECT * FROM supplier_payment_batches WHERE company_id=${companyId}::uuid AND id=${id}::uuid FOR UPDATE` as Record<string,unknown>[];
  if(!before||before.status!=='draft')throw new Error('Draft batch required');
  const payments=await ctx.sql`SELECT * FROM supplier_payments WHERE company_id=${companyId}::uuid AND batch_id=${id}::uuid ORDER BY id FOR UPDATE` as Record<string,unknown>[];
  if(payments.length!==Number(before.payment_count)||payments.some(payment=>payment.status!=='draft'))throw new Error('Batch payment population changed');
  for(const payment of payments){
   const [after]=await ctx.sql`UPDATE supplier_payments SET status=${status} WHERE company_id=${companyId}::uuid AND id=${String(payment.id)}::uuid RETURNING *` as Record<string,unknown>[];
   if(!after)throw new Error('Batch payment disappeared');await recordBatchEntity(ctx,'supplier_payment',payment,after,`supplier_payment.${status}`);
  }
  const [after]=await ctx.sql`UPDATE supplier_payment_batches SET status=${status} WHERE company_id=${companyId}::uuid AND id=${id}::uuid RETURNING *` as Record<string,unknown>[];
  if(!after)throw new Error('Batch disappeared');await recordBatchEntity(ctx,'supplier_payment_batch',before,after,`supplier_payment_batch.${status}`);
 });
}
