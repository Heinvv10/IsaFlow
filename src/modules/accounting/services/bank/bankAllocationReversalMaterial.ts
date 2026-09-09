import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../controls/canonical';
import {readControlEntityVersion} from '../controls/operationVersions';
import {assertControlTx} from '../controls/context';
import type {ControlTx,OperationRef} from '../controls/contracts';
import type {ApMaterial} from '../controls/apOperationMaterializer';
import {loadBankAllocationOriginal,assertOriginalAllocationReversible} from './bankAllocationReversalSources';
type Row=Record<string,unknown>;
export async function loadBankAllocationReversal(ctx:ControlTx,id:string,permit?:ControlledEffectPermit){
 assertControlTx(ctx);if(permit)assertControlledEffectPermit(ctx,permit,{entityType:'bank_allocation_reversal_intent',entityId:id,operation:'bank_allocation.reverse'});const company=ctx.principal.companyId;
 const [intent]=await ctx.sql`SELECT *,reversal_date::text FROM control_bank_allocation_reversal_intents WHERE company_id=${company}::uuid AND id=${id}::uuid` as Row[];
 if(!intent)throw new Error('Bank allocation reversal intent not found');
 const original=await loadBankAllocationOriginal(ctx,String(intent.original_intent_id));
 if(original.plan.bankTransactionId!==intent.bank_transaction_id)throw new Error('Reversal bank association changed');
 const periods=await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${company}::uuid AND start_date<=${intent.reversal_date}::date AND end_date>=${intent.reversal_date}::date ORDER BY id FOR UPDATE` as Row[];
 const vatLocks=await ctx.sql`SELECT * FROM vat_period_locks WHERE company_id=${company}::uuid AND period_start<=${intent.reversal_date}::date AND period_end>=${intent.reversal_date}::date ORDER BY id FOR SHARE` as Row[];
 const contras=await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${company}::uuid AND reversal_of_id=${original.journal.id}::uuid ORDER BY id FOR SHARE` as Row[];
 const facts={intent,original,periods,vatLocks,contras},fingerprint=createHash('sha256').update(canonicalJson(facts)).digest('hex');
 const [effect]=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${company}::uuid AND operation='bank_allocation.reverse'
  AND entity_type='bank_allocation_reversal_intent' AND entity_id=${id} ORDER BY committed_at DESC LIMIT 1` as {id:string;result:{afterFingerprint:string;reversalJournalEntryId:string}}[];
 if(effect){
  if(effect.result.afterFingerprint!==fingerprint||!original.journal.reversed_at||original.sources.bank.status!=='imported'
   ||!contras.some(j=>j.id===effect.result.reversalJournalEntryId&&j.status==='posted'))throw new Error('Bank reversal receipt changed');
 }else if(!permit&&(contras.some(j=>j.status==='posted')||original.journal.reversed_at))throw new Error('Bank allocation already reversed');
 return{...facts,fingerprint,effect};
}
export async function materializeBankAllocationReversal(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.entityType!=='bank_allocation_reversal_intent'||ref.operation!=='bank_allocation.reverse')throw new Error('Unsupported allocation reversal');
 const state=await loadBankAllocationReversal(ctx,ref.entityId);
 if(!state.effect)await assertOriginalAllocationReversible(ctx,String(state.intent.original_intent_id));
 const prior=await readControlEntityVersion(ctx,ref);const {effect:_effect,...facts}=state;
 const parent={entityType:ref.entityType,entityId:ref.entityId,version:prior?.version??1,tracked:prior!==null,facts,
  fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex')};
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Allocation reversal version changed');
 const b=state.original.sources.beneficiary;
 return{supplierId:state.original.plan.kind==='supplier'?state.original.plan.partyId:'',observedSources:[parent],versionBasis:prior?'recorded_with_current_fingerprint':'untracked_current_observation',
  binding:{companyId:ctx.principal.companyId,entityType:ref.entityType,entityId:ref.entityId,operation:ref.operation,entityVersion:parent.version,
   accountingDate:String(state.intent.reversal_date),amount:String(state.original.intent.amount),currency:'ZAR',beneficiaries:b?[{entityType:b.entityType,entityId:b.entityId,beneficiaryId:b.beneficiaryId,version:b.version,fingerprint:b.fingerprint,amount:String(state.original.intent.amount),currency:'ZAR'}]:[],
   sourceVersions:[{entityType:parent.entityType,entityId:parent.entityId,version:parent.version,fingerprint:parent.fingerprint}]}};
}
