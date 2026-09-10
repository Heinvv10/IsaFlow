import {createHash} from 'node:crypto';
import {isRealCalendarDate} from '@/lib/validation';
import type {ControlTx,OperationRef} from '../controls/contracts';
import type {ApMaterial} from '../controls/apOperationMaterializer';
import {assertControlTx} from '../controls/context';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {canonicalJson} from '../controls/canonical';
import {readControlEntityVersion} from '../controls/operationVersions';
import {loadIntentReceipt,sameIntentId} from '../controls/intentIdentity';
import {loadOriginalCashApplication,assertCashApplicationReversible} from './cashApplicationReversalSources';
import {cashApplicationTotal} from './cashApplicationPlan';
type Row=Record<string,unknown>;
export async function loadCashApplicationReversal(ctx:ControlTx,id:string,permit?:ControlledEffectPermit){
 assertControlTx(ctx);if(permit)assertControlledEffectPermit(ctx,permit,{entityType:permit.entityType,entityId:id,operation:permit.operation});
 if(permit&&(permit.entityType!=='cash_application_reversal_intent'||String(permit.operation)!=='cash_application.reverse'))throw new Error('Cash reversal parent required');
 const company=ctx.principal.companyId;
 const [intent]=await ctx.sql`SELECT *,reversal_date::text FROM control_cash_application_reversal_intents WHERE company_id=${company}::uuid AND id=${id}::uuid` as Row[];
 if(!intent)throw new Error('Owned cash reversal intent required');
 const original=await loadOriginalCashApplication(ctx,String(intent.original_intent_id));
 if(!isRealCalendarDate(String(intent.reversal_date))||String(intent.reversal_date)<original.plan.accountingDate)throw new Error('Cash reversal date precedes application');
 const periods=await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${company}::uuid AND start_date<=${intent.reversal_date}::date AND end_date>=${intent.reversal_date}::date ORDER BY id FOR UPDATE` as Row[];
 const vatLocks=await ctx.sql`SELECT * FROM vat_period_locks WHERE company_id=${company}::uuid AND period_start<=${intent.reversal_date}::date AND period_end>=${intent.reversal_date}::date ORDER BY id FOR SHARE` as Row[];
 const facts={intent,original,periods,vatLocks},fingerprint=createHash('sha256').update(canonicalJson(facts)).digest('hex');
 const effect=await loadIntentReceipt<{intentId:string;afterFingerprint:string}>(ctx,{entityType:'cash_application_reversal_intent',entityId:id,operation:'cash_application.reverse'});
 if(effect){if(!sameIntentId(effect.result.intentId,id)||effect.result.afterFingerprint!==fingerprint||original.rows.some(a=>!a.reversed_at||a.reversal_intent_id!==id))throw new Error('Cash reversal receipt material changed');}
 else if(!permit&&original.rows.some(a=>a.reversed_at!=null||a.reversal_intent_id!=null))throw new Error('Cash application already reversed');
 return{...facts,fingerprint,effect};
}
export async function materializeCashApplicationReversal(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.entityType!=='cash_application_reversal_intent'||String(ref.operation)!=='cash_application.reverse')throw new Error('Unsupported cash reversal operation');
 const state=await loadCashApplicationReversal(ctx,ref.entityId);if(!state.effect)await assertCashApplicationReversible(ctx,String(state.intent.original_intent_id));
 const prior=await readControlEntityVersion(ctx,ref),{effect:_effect,...facts}=state;
 const parent={entityType:ref.entityType,entityId:ref.entityId,version:prior?.version??1,tracked:prior!==null,facts,fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex')};
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Cash reversal version changed');
 const amount=cashApplicationTotal(state.original.plan),b=state.original.sources.beneficiary;
 return{supplierId:state.original.plan.kind==='supplier'?String(state.original.sources.party.id):'',observedSources:[parent],versionBasis:prior?'recorded_with_current_fingerprint':'untracked_current_observation',
  binding:{companyId:ctx.principal.companyId,entityType:ref.entityType,entityId:ref.entityId,operation:ref.operation,entityVersion:parent.version,
   accountingDate:String(state.intent.reversal_date),amount,currency:'ZAR',beneficiaries:b?[{entityType:b.entityType,entityId:b.entityId,beneficiaryId:b.beneficiaryId,version:b.version,fingerprint:b.fingerprint,amount,currency:'ZAR'}]:[],
   sourceVersions:[{entityType:parent.entityType,entityId:parent.entityId,version:parent.version,fingerprint:parent.fingerprint}]}};
}
