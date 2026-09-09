import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import {canonicalJson} from '../controls/canonical';
import {readControlEntityVersion} from '../controls/operationVersions';
import type {ControlTx,EntityRef,OperationRef} from '../controls/contracts';
import type {ApMaterial,ObservedSource} from '../controls/apOperationMaterializer';
import {selectApSystemAccount} from './apControlAccounts';
import {loadPreparedBatch,loadBatchBankAccount} from './paymentBatchSource';
export async function observePaymentSource(ctx:ControlTx,ref:EntityRef,facts:Record<string,unknown>):Promise<ObservedSource>{
 const version=await readControlEntityVersion(ctx,ref);
 return{...ref,version:version?.version??1,tracked:version!==null,
  fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex'),facts};
}
export async function materializePaymentBatchOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.entityType!=='supplier_payment_batch'||ref.operation!=='supplier_payment_batch.process')throw new Error('Unsupported payment batch operation');
 const material=await loadPreparedBatch(ctx,ref.entityId),bank=await loadBatchBankAccount(ctx,material.batch.bank_account_id);
 const accounts=await ctx.sql`SELECT id,account_code,account_type,account_subtype,is_active,is_system_account FROM gl_accounts
  WHERE company_id=${ctx.principal.companyId}::uuid AND account_subtype='payable' AND is_system_account=true AND is_active=true ORDER BY id FOR SHARE` as Array<Record<string,unknown>&{id:string}>;
 const payable=selectApSystemAccount(accounts,'payable');
 const [ledger]=await ctx.sql`SELECT default_currency FROM companies WHERE id=${ctx.principal.companyId}::uuid FOR SHARE` as Array<{default_currency:string}>;
 if(ledger?.default_currency!==material.currency)throw new Error('Batch currency differs from ledger currency');
 const parent=await observePaymentSource(ctx,ref,{batch:material.batch,bank,payable});
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Operation version changed');
 const observedSources=[parent];const beneficiaries=new Map<string,ApMaterial['binding']['beneficiaries'][number]>();
 for(const payment of material.payments){
  observedSources.push(await observePaymentSource(ctx,{entityType:'supplier_payment',entityId:payment.payment.id},{...payment.facts,status:payment.payment.status}));
  const prior=beneficiaries.get(payment.payment.supplier_id),b=payment.beneficiary;
  beneficiaries.set(payment.payment.supplier_id,{entityType:'supplier',entityId:b.entityId,beneficiaryId:b.beneficiaryId,
   version:b.version,fingerprint:b.fingerprint,currency:payment.currency,amount:new Decimal(prior?.amount??'0').add(payment.amount).toFixed()});
 }
 return{observedSources,supplierId:beneficiaries.size===1?[...beneficiaries.keys()][0]!:'',
  versionBasis:observedSources.every(row=>row.tracked)?'recorded_with_current_fingerprint':'untracked_current_observation',
  binding:{companyId:ctx.principal.companyId,operation:ref.operation,entityType:ref.entityType,entityId:ref.entityId,entityVersion:parent.version,
   accountingDate:material.batch.batch_date,amount:material.amount,currency:material.currency,beneficiaries:[...beneficiaries.values()],
   sourceVersions:observedSources.map(({facts:_facts,tracked:_tracked,...row})=>row)}};
}
