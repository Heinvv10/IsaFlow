import Decimal from 'decimal.js';
import {assertControlTx} from '../controls/context';
import type {ControlTx,OperationRef} from '../controls/contracts';
import type {ApMaterial} from '../controls/apOperationMaterializer';
import type {ProtectedChange} from '../controls/changeProtection';
import {loadPreparedPayment} from './paymentPreparationService';
import {openReleasePayload,validateReleaseFileFields} from './paymentReleasePayload';
import {validateReleasePopulation} from './paymentReleaseValidation';
import {observePaymentSource} from './paymentBatchMaterializer';
import {loadBatchBankAccount} from './paymentBatchSource';
import {releaseConfigurationFingerprint,releaseSourceFingerprint} from './paymentReleaseFingerprint';
export interface ReleaseIntentRow extends Record<string,unknown>{id:string;batch_id:string;channel:'netcash'|'eft';bank_format:string|null;payload_envelope:ProtectedChange;payload_hash:string;amount:string;currency:string;accounting_date:string;requester_person_id:string}
export async function loadPaymentReleaseIntent(ctx:ControlTx,intentId:string){
 assertControlTx(ctx);
 const [intent]=await ctx.sql`SELECT *,amount::text,accounting_date::text FROM control_payment_release_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${intentId}::uuid` as ReleaseIntentRow[];
 if(!intent)throw new Error('Payment release not found');
 const payload=openReleasePayload(ctx.principal.companyId,intentId,intent.payload_envelope,intent.payload_hash);
 if(payload.channel!==intent.channel||payload.bankFormat!==intent.bank_format||payload.header.actionDate!==intent.accounting_date)throw new Error('Release envelope metadata changed');
 const items=await ctx.sql`SELECT payment_id,preparation_id FROM control_payment_release_items
  WHERE company_id=${ctx.principal.companyId}::uuid AND intent_id=${intentId}::uuid ORDER BY payment_id LIMIT 101` as Array<{payment_id:string;preparation_id:string}>;
 if(!items.length||items.length>100||items.length!==payload.payments.length)throw new Error('Release item population changed');
 const payments=[];for(const item of items)payments.push(await loadPreparedPayment(ctx,item.payment_id,item.preparation_id));
 if(payments.some(p=>p.payment.batch_id!==intent.batch_id||!['approved','processed'].includes(p.payment.status)))throw new Error('Release payment eligibility changed');
 const money=validateReleasePopulation(payments.map(p=>({id:p.payment.id,supplierId:p.payment.supplier_id,amount:p.amount,currency:p.currency})),intent.amount,items.length);
 if(money.currency!==intent.currency)throw new Error('Release currency changed');
 const [batch]=await ctx.sql`SELECT id,bank_account_id,batch_date::text,payment_count,total_amount::text,status
  FROM supplier_payment_batches WHERE company_id=${ctx.principal.companyId}::uuid AND id=${intent.batch_id}::uuid FOR UPDATE` as Array<{id:string;bank_account_id:string|null;batch_date:string;payment_count:number;total_amount:string;status:string}>;
 if(!batch||!['approved','processed'].includes(batch.status)||Number(batch.payment_count)!==items.length||batch.batch_date!==intent.accounting_date
  ||!new Decimal(batch.total_amount).eq(intent.amount))throw new Error('Release batch changed');
 if(releaseSourceFingerprint(batch,payments)!==payload.sourceFingerprint)throw new Error('Release invoice or settlement sources changed; fresh release approval required');
 const bank=await loadBatchBankAccount(ctx,batch.bank_account_id);
 if(bank.bank_account_number!==payload.header.bankAccountNumber||bank.bank_branch_code!==payload.header.branchCode||bank.bank_account_type!==payload.header.accountType)throw new Error('Sender banking changed');
 for(let i=0;i<payments.length;i++){
  const payment=payments[i]!,bound=payload.payments[i]!;
  if(payment.beneficiary.details.accountNumber!==bound.beneficiaryAccountNumber||payment.beneficiary.details.branchCode!==bound.beneficiaryBranchCode
   ||!new Decimal(bound.amount).eq(payment.amount))throw new Error('Payment payload differs from verified preparation');
 }
 if(intent.channel==='eft')validateReleaseFileFields(payload.header,payload.payments);
 else{
  const [settings]=await ctx.sql`SELECT netcash_enabled,netcash_service_key,netcash_payouts_key FROM companies WHERE id=${ctx.principal.companyId}::uuid FOR SHARE` as Array<{netcash_enabled:boolean;netcash_service_key:string|null;netcash_payouts_key:string|null}>;
  if(!settings?.netcash_enabled||!settings.netcash_service_key||!settings.netcash_payouts_key
   ||releaseConfigurationFingerprint(ctx.principal.companyId,settings.netcash_service_key,settings.netcash_payouts_key)!==payload.providerConfigurationFingerprint)throw new Error('Release provider configuration changed');
 }
 return{intent,payload,payments,batch,...money};
}
export async function materializePaymentReleaseOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.entityType!=='payment_release_intent'||ref.operation!=='payment_release.dispatch')throw new Error('Unsupported payment release operation');
 const material=await loadPaymentReleaseIntent(ctx,ref.entityId);
 const parent=await observePaymentSource(ctx,ref,{id:material.intent.id,batchId:material.intent.batch_id,payloadHash:material.intent.payload_hash,
  channel:material.intent.channel,bankFormat:material.intent.bank_format,amount:material.amount,currency:material.currency,accountingDate:material.intent.accounting_date});
 if(ref.expectedVersion!==undefined&&parent.version!==ref.expectedVersion)throw new Error('Release version changed');
 const observedSources=[parent],beneficiaries=new Map<string,ApMaterial['binding']['beneficiaries'][number]>();
 for(const p of material.payments){
  observedSources.push(await observePaymentSource(ctx,{entityType:'payment_preparation',entityId:p.preparationId},{paymentId:p.payment.id,paymentFingerprint:p.fingerprint,beneficiaryVersion:p.beneficiary.version}));
  const b=p.beneficiary,prior=beneficiaries.get(b.entityId);
  beneficiaries.set(b.entityId,{entityType:'supplier',entityId:b.entityId,beneficiaryId:b.beneficiaryId,version:b.version,fingerprint:b.fingerprint,
   amount:new Decimal(prior?.amount??'0').add(p.amount).toFixed(),currency:p.currency});
 }
 return{observedSources,supplierId:beneficiaries.size===1?[...beneficiaries.keys()][0]!:'',
  versionBasis:observedSources.every(r=>r.tracked)?'recorded_with_current_fingerprint':'untracked_current_observation',
  binding:{companyId:ctx.principal.companyId,operation:ref.operation,entityType:ref.entityType,entityId:ref.entityId,entityVersion:parent.version,
   accountingDate:material.intent.accounting_date,amount:material.amount,currency:material.currency,beneficiaries:[...beneficiaries.values()],
   sourceVersions:observedSources.map(({facts:_facts,tracked:_tracked,...r})=>r)}};
}
