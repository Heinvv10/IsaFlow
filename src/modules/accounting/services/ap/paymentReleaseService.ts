import {randomUUID} from 'node:crypto';
import {releaseConfigurationFingerprint,releaseSourceFingerprint} from './paymentReleaseFingerprint';
import {als} from '@/lib/als';
import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import {recordCommittedChange} from '../controls/changeEventService';
import {executeControlledOperation} from '../controls/approvalExecutionService';
import type {ControlTx} from '../controls/contracts';
import type {EFTPayment} from './eftService';
import {loadPreparedBatch,loadBatchBankAccount} from './paymentBatchSource';
import {sealReleasePayload,EFT_FORMATS,validateReleaseFileFields,type ReleaseChannel,type ReleaseBankFormat,type PaymentReleasePayload} from './paymentReleasePayload';
function releaseAccountType(value:string):EFTPayment['beneficiaryAccountType']{
 if(value==='cheque'||value==='current')return 'current';
 if(value==='savings'||value==='transmission')return value;
 throw new Error('Unsupported beneficiary account type');
}
function poison(){const store=als.getStore();if(store)store.controlWriteFailed=true;}
export async function createPaymentReleaseIntent(ctx:ControlTx,input:{batchId:string;channel:ReleaseChannel;bankFormat?:ReleaseBankFormat}){
 try{
  assertControlTx(ctx);await assertEffectivePermission(ctx,'write:release');
  if(!UUID_RE.test(input.batchId)||!['netcash','eft'].includes(input.channel)
   ||(input.channel==='eft'&&!EFT_FORMATS.includes(input.bankFormat!))||(input.channel==='netcash'&&input.bankFormat!==undefined))throw new Error('Invalid release intent');
  return await withSavepoint('payment_release_prepare',async()=>{
   const batch=await loadPreparedBatch(ctx,input.batchId);
   if(!['approved','processed'].includes(batch.batch.status)||batch.payments.some(p=>!['approved','processed'].includes(p.payment.status)))throw new Error('Approved payment batch required');
   const bank=await loadBatchBankAccount(ctx,batch.batch.bank_account_id);
   const [company]=await ctx.sql`SELECT name,netcash_service_key,netcash_payouts_key,netcash_enabled FROM companies
    WHERE id=${ctx.principal.companyId}::uuid FOR SHARE` as Array<{name:string;netcash_service_key:string|null;netcash_payouts_key:string|null;netcash_enabled:boolean}>;
   if(!company)throw new Error('Company unavailable');
   if(input.channel==='netcash'&&(!company.netcash_enabled||!company.netcash_service_key||!company.netcash_payouts_key))throw new Error('Netcash credentials are unavailable');
   if(!['current','savings'].includes(bank.bank_account_type))throw new Error('Unsupported sender bank account type');
   const id=randomUUID();
   const payload:PaymentReleasePayload={version:1,companyId:ctx.principal.companyId,intentId:id,channel:input.channel,bankFormat:input.bankFormat??null,
    sourceFingerprint:releaseSourceFingerprint(batch.batch,batch.payments),
    providerConfigurationFingerprint:input.channel==='netcash'?releaseConfigurationFingerprint(ctx.principal.companyId,company.netcash_service_key!,company.netcash_payouts_key!):null,
    header:{companyName:company.name,bankAccountNumber:bank.bank_account_number??'',branchCode:bank.bank_branch_code??'',accountType:bank.bank_account_type as 'current'|'savings',batchReference:id.slice(0,12),actionDate:batch.batch.batch_date},
    payments:batch.payments.map(p=>({beneficiaryName:'',
     beneficiaryAccountNumber:p.beneficiary.details.accountNumber,beneficiaryBranchCode:p.beneficiary.details.branchCode,
     beneficiaryAccountType:releaseAccountType(p.beneficiary.details.accountType),
     amount:Number(p.amount),reference:p.payment.reference??p.payment.id.slice(0,12),beneficiaryBank:p.beneficiary.details.bankName}))};
   // Beneficiary display names are owned supplier facts, never inferred from an invoice/payment reference.
   for(let i=0;i<batch.payments.length;i++){
    const [supplier]=await ctx.sql`SELECT name FROM suppliers WHERE company_id=${ctx.principal.companyId}::uuid AND id=${batch.payments[i]!.payment.supplier_id}::uuid FOR SHARE` as Array<{name:string}>;
    if(!supplier)throw new Error('Supplier unavailable');payload.payments[i]!.beneficiaryName=supplier.name;
   }
   if(input.channel==='eft')validateReleaseFileFields(payload.header,payload.payments);
   const sealed=sealReleasePayload(payload);
   await ctx.sql`INSERT INTO control_payment_release_intents(company_id,id,batch_id,channel,bank_format,requester_person_id,requester_auth_method,
    requester_grant_id,requester_granted_scopes,payload_envelope,payload_hash,amount,currency,accounting_date)
    VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${input.batchId}::uuid,${input.channel},${input.bankFormat??null},${ctx.principal.personId},${ctx.principal.authMethod},
     ${ctx.principal.authMethod==='cookie'?null:ctx.principal.authMethod==='pat'?ctx.principal.connectionId:ctx.principal.grantId}::uuid,
     ${ctx.principal.grantedScopes===null?null:[...ctx.principal.grantedScopes]}::text[],${JSON.stringify(sealed.envelope)}::jsonb,${sealed.hash},${batch.amount}::numeric,${batch.currency},${batch.batch.batch_date}::date)`;
   for(const payment of batch.payments)await ctx.sql`INSERT INTO control_payment_release_items(company_id,intent_id,payment_id,preparation_id)
    VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${payment.payment.id}::uuid,${payment.preparationId}::uuid)`;
   await recordCommittedChange(ctx,{entityType:'payment_release_intent',entityId:id,previousVersion:null,newVersion:1,action:'payment_release.prepared',accountingDate:batch.batch.batch_date,
    before:null,after:{status:'prepared',amount:batch.amount,currency:batch.currency,paymentCount:batch.payments.length,channel:input.channel},bindingHash:null,protectedEvidenceRef:null});
   return{intentId:id,status:'prepared' as const,paymentCount:batch.payments.length,amount:batch.amount,currency:batch.currency};
  });
 }catch(error){poison();throw error;}
}
export async function enqueuePaymentRelease(ctx:ControlTx,intentId:string,approvalId:string){
 try{
  assertControlTx(ctx);if(!UUID_RE.test(intentId)||!UUID_RE.test(approvalId))throw new Error('A release approval reference is required');
  return await executeControlledOperation(ctx,{operation:'payment_release.dispatch',entityType:'payment_release_intent',entityId:intentId},approvalId,async()=>{
   const [approval]=await ctx.sql`SELECT binding FROM control_operation_approvals WHERE company_id=${ctx.principal.companyId}::uuid AND id=${approvalId}::uuid` as Array<{binding:{policies:Array<{mandatory:boolean}>}}>;
   if(!approval?.binding.policies.some(p=>p.mandatory))throw new Error('Mandatory independent release approval is required');
   const items=await ctx.sql`SELECT payment_id FROM control_payment_release_items WHERE company_id=${ctx.principal.companyId}::uuid AND intent_id=${intentId}::uuid ORDER BY payment_id` as Array<{payment_id:string}>;
   if(!items.length||items.length>100)throw new Error('Invalid release payment population');
   for(const item of items)await ctx.sql`INSERT INTO control_payment_release_reservations(company_id,payment_id,intent_id)
    VALUES(${ctx.principal.companyId}::uuid,${item.payment_id}::uuid,${intentId}::uuid)`;
   await ctx.sql`INSERT INTO control_payment_release_outbox(company_id,intent_id,approval_id,provider_reference,state)
    VALUES(${ctx.principal.companyId}::uuid,${intentId}::uuid,${approvalId}::uuid,${intentId},'ready')`;
   return{intentId,status:'queued' as const};
  });
 }catch(error){poison();throw error;}
}
