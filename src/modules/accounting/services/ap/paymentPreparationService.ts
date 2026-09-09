import {randomUUID} from 'node:crypto';
import {als} from '@/lib/als';
import {withSavepoint} from '@/lib/neon';
import {assertControlTx} from '../controls/context';
import {recordCommittedChange} from '../controls/changeEventService';
import type {ControlTx} from '../controls/contracts';
import {loadPaymentReleaseSource} from './paymentReleaseSource';
export interface PaymentPreparation {id:string;payment_fingerprint:string;beneficiary_version_id:string;beneficiary_version:number|string;beneficiary_fingerprint:string}
export function assertPreparedPaymentCurrent(preparation:Omit<PaymentPreparation,'id'>,fingerprint:string,
 beneficiary:{beneficiaryId:string;version:number;fingerprint:string}):void{
 if(preparation.payment_fingerprint!==fingerprint||preparation.beneficiary_version_id!==beneficiary.beneficiaryId
  ||Number(preparation.beneficiary_version)!==beneficiary.version||preparation.beneficiary_fingerprint!==beneficiary.fingerprint){
  throw new Error('Payment or beneficiary changed; reprepare and obtain fresh release approval');
 }
}
/** Deliberate re-preparation creates a new immutable observation, never upgrades an existing release intent. */
export async function prepareSupplierPayment(ctx:ControlTx,paymentId:string):Promise<{preparationId:string;status:'prepared'}>{
 try{
  assertControlTx(ctx);
  return await withSavepoint('payment_preparation',async()=>{
   const source=await loadPaymentReleaseSource(ctx,paymentId),company=ctx.principal.companyId;
   const existing=await ctx.sql`SELECT id FROM control_payment_preparations WHERE company_id=${company}::uuid
    AND payment_id=${paymentId}::uuid AND payment_fingerprint=${source.fingerprint}
    AND beneficiary_version_id=${source.beneficiary.beneficiaryId}::uuid` as Array<{id:string}>;
   if(existing[0])return{preparationId:existing[0].id,status:'prepared' as const};
   const id=randomUUID();
   await ctx.sql`INSERT INTO control_payment_preparations(company_id,id,payment_id,supplier_id,beneficiary_version_id,
    beneficiary_version,beneficiary_fingerprint,payment_fingerprint,amount,currency,prepared_by_person_id)
    VALUES(${company}::uuid,${id}::uuid,${paymentId}::uuid,${source.payment.supplier_id}::uuid,${source.beneficiary.beneficiaryId}::uuid,
     ${source.beneficiary.version},${source.beneficiary.fingerprint},${source.fingerprint},${source.amount}::numeric,${source.currency},${ctx.principal.personId})`;
   await recordCommittedChange(ctx,{entityType:'payment_preparation',entityId:id,previousVersion:null,newVersion:1,
    action:'payment.prepared',accountingDate:source.payment.payment_date,before:null,
    after:{paymentId,beneficiaryVersion:source.beneficiary.version,status:'prepared'},bindingHash:null,protectedEvidenceRef:null});
   return{preparationId:id,status:'prepared' as const};
  });
 }catch(error){const store=als.getStore();if(store)store.controlWriteFailed=true;throw error;}
}
export async function loadPreparedPayment(ctx:ControlTx,paymentId:string,preparationId:string){
 const source=await loadPaymentReleaseSource(ctx,paymentId);
 const rows=await ctx.sql`SELECT id,payment_fingerprint,beneficiary_version_id,beneficiary_version,beneficiary_fingerprint
  FROM control_payment_preparations WHERE company_id=${ctx.principal.companyId}::uuid
  AND id=${preparationId}::uuid AND payment_id=${paymentId}::uuid` as PaymentPreparation[];
 if(rows.length!==1)throw new Error('Payment preparation not found');
 assertPreparedPaymentCurrent(rows[0]!,source.fingerprint,source.beneficiary);
 return{...source,preparationId};
}
