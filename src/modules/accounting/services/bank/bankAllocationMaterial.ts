import {createHash} from 'node:crypto';
import {canonicalJson} from '../controls/canonical';
import {readControlEntityVersion} from '../controls/operationVersions';
import type {ControlTx,OperationRef} from '../controls/contracts';
import type {ApMaterial} from '../controls/apOperationMaterializer';
import {parseBankAllocationPlan} from './bankAllocationPlan';
import {loadBankAllocationSources} from './bankAllocationSources';
interface Intent {id:string;requester_person_id:string;bank_transaction_id:string;accounting_date:string;amount:string;currency:string;payload:unknown;source_fingerprint:string}
export async function loadBankAllocationIntent(ctx:ControlTx,id:string){
 const [intent]=await ctx.sql`SELECT *,accounting_date::text,amount::text FROM control_bank_allocation_intents WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid` as Intent[];
 if(!intent)throw new Error('Bank allocation intent not found');
 const plan=parseBankAllocationPlan(intent.payload);
 if(plan.bankTransactionId!==intent.bank_transaction_id)throw new Error('Allocation intent association changed');
 const sources=await loadBankAllocationSources(ctx,plan);
 const [effect]=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
  AND operation='bank_allocation.post' AND entity_type='bank_allocation_intent' AND entity_id=${id} ORDER BY committed_at DESC LIMIT 1` as {id:string;result:{intentId:string;journalEntryId:string;afterFingerprint:string}}[];
 if(effect){
  if(effect.result.intentId!==id||effect.result.afterFingerprint!==sources.fingerprint||sources.bank.status!=='allocated')throw new Error('Allocation receipt source changed');
  const [journal]=await ctx.sql`SELECT je.id FROM gl_journal_entries je JOIN gl_journal_lines jl ON jl.company_id=je.company_id AND jl.journal_entry_id=je.id
   WHERE je.company_id=${ctx.principal.companyId}::uuid AND je.id=${effect.result.journalEntryId}::uuid AND je.status='posted' AND je.reversed_at IS NULL
    AND je.source_record_id=${intent.bank_transaction_id}::uuid AND jl.id=${sources.bank.matched_journal_line_id}::uuid`;
  if(!journal)throw new Error('Allocation receipt journal changed');
 }else if(sources.bank.status!=='imported'||sources.fingerprint!==intent.source_fingerprint)throw new Error('Allocation source changed; prepare a fresh intent');
 return{intent,plan,sources,effect};
}
export async function materializeBankAllocationOperation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.entityType!=='bank_allocation_intent'||ref.operation!=='bank_allocation.post')throw new Error('Unsupported bank allocation operation');
 const material=await loadBankAllocationIntent(ctx,ref.entityId),prior=await readControlEntityVersion(ctx,ref);
 const facts={intent:material.intent,source:material.sources};
 const b=material.sources.beneficiary;
 const parent={entityType:ref.entityType,entityId:ref.entityId,version:prior?.version??1,tracked:prior!==null,facts,
  fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex')};
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Allocation version changed');
 return{supplierId:material.plan.kind==='supplier'?material.plan.partyId:'',observedSources:[parent],
  versionBasis:prior?'recorded_with_current_fingerprint':'untracked_current_observation',
  binding:{companyId:ctx.principal.companyId,entityType:ref.entityType,entityId:ref.entityId,operation:ref.operation,entityVersion:parent.version,
   accountingDate:material.intent.accounting_date,amount:material.intent.amount,currency:material.intent.currency,beneficiaries:b?[{entityType:b.entityType,entityId:b.entityId,beneficiaryId:b.beneficiaryId,version:b.version,fingerprint:b.fingerprint,amount:material.intent.amount,currency:material.intent.currency}]:[],
   sourceVersions:[{entityType:parent.entityType,entityId:parent.entityId,version:parent.version,fingerprint:parent.fingerprint}]}};
}
