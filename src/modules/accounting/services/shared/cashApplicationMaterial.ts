import {materializeCashApplicationReversal} from './cashApplicationReversalMaterial';
import Decimal from 'decimal.js';
const D=Decimal.clone({precision:80});
import {createHash} from 'node:crypto';
import type {ControlTx,OperationRef} from '../controls/contracts';
import type {ApMaterial} from '../controls/apOperationMaterializer';
import {assertControlTx} from '../controls/context';
import {readControlEntityVersion} from '../controls/operationVersions';
import {loadIntentReceipt,sameIntentId} from '../controls/intentIdentity';
import {canonicalJson} from '../controls/canonical';
import {parseCashApplicationPlan,cashApplicationTotal} from './cashApplicationPlan';
import {loadCashApplicationSources} from './cashApplicationSources';
type Intent={id:string;requester_person_id:string;payment_id:string;kind:string;accounting_date:string;amount:string;currency:string;payload:unknown;source_fingerprint:string};
export async function loadCashApplicationIntent(ctx:ControlTx,id:string){
 assertControlTx(ctx);const company=ctx.principal.companyId;
 const [intent]=await ctx.sql`SELECT *,accounting_date::text,amount::text FROM control_cash_application_intents WHERE company_id=${company}::uuid AND id=${id}::uuid` as Intent[];
 if(!intent)throw new Error('Owned cash application intent required');
 const plan=parseCashApplicationPlan(intent.payload);
 if(plan.paymentId!==intent.payment_id||plan.kind!==intent.kind||plan.accountingDate!==intent.accounting_date||intent.currency!=='ZAR'
  ||!new D(intent.amount).eq(cashApplicationTotal(plan)))throw new Error('Cash application intent binding invalid');
 const sources=await loadCashApplicationSources(ctx,plan);
 const effect=await loadIntentReceipt<{intentId:string;afterFingerprint:string}>(ctx,{entityType:'cash_application_intent',entityId:id,operation:'cash_application.apply'});
 if(effect){if(!sameIntentId(effect.result.intentId,id)||effect.result.afterFingerprint!==sources.fingerprint)throw new Error('Cash application receipt material changed');}
 else if(intent.source_fingerprint!==sources.fingerprint)throw new Error('Cash application sources changed');
 return{intent,plan,sources,effect};
}
export async function materializeCashApplicationOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.entityType==='cash_application_reversal_intent')return materializeCashApplicationReversal(ctx,ref);
 if(ref.entityType!=='cash_application_intent'||String(ref.operation)!=='cash_application.apply')throw new Error('Unsupported cash application operation');
 const material=await loadCashApplicationIntent(ctx,ref.entityId),prior=await readControlEntityVersion(ctx,ref);
 const {effect:_effect,...facts}=material;
 const parent={entityType:ref.entityType,entityId:ref.entityId,version:prior?.version??1,tracked:prior!==null,facts,fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex')};
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Cash application version changed');
 const b=material.sources.beneficiary,amount=cashApplicationTotal(material.plan);
 return{supplierId:material.plan.kind==='supplier'?String(material.sources.party.id):'',observedSources:[parent],versionBasis:prior?'recorded_with_current_fingerprint':'untracked_current_observation',
  binding:{companyId:ctx.principal.companyId,entityType:ref.entityType,entityId:ref.entityId,operation:ref.operation,entityVersion:parent.version,
   accountingDate:material.plan.accountingDate,amount,currency:'ZAR',beneficiaries:b?[{entityType:b.entityType,entityId:b.entityId,beneficiaryId:b.beneficiaryId,version:b.version,fingerprint:b.fingerprint,amount,currency:'ZAR'}]:[],
   sourceVersions:[{entityType:parent.entityType,entityId:parent.entityId,version:parent.version,fingerprint:parent.fingerprint}]}};
}
