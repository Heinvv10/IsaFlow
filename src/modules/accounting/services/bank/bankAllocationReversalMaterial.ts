import {assertTransferBankLinks} from './bankAllocationTransferOriginal';
import Decimal from 'decimal.js';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../controls/canonical';
import {readControlEntityVersion} from '../controls/operationVersions';
import {loadIntentReceipt} from '../controls/intentIdentity';
import {assertControlTx} from '../controls/context';
import type {ControlTx,OperationRef} from '../controls/contracts';
import type {ApMaterial} from '../controls/apOperationMaterializer';
import {loadBankAllocationOriginal,assertOriginalAllocationReversible} from './bankAllocationReversalSources';
type Row=Record<string,unknown>;
export async function loadBankAllocationReversal(ctx:ControlTx,id:string,permit?:ControlledEffectPermit){
 assertControlTx(ctx);if(permit)assertControlledEffectPermit(ctx,permit,{entityType:'bank_allocation_reversal_intent',entityId:id,operation:'bank_allocation.reverse'});const company=ctx.principal.companyId;
 const [intent]=await ctx.sql`SELECT *,reversal_date::text FROM control_bank_allocation_reversal_intents WHERE company_id=${company}::uuid AND id=${id}::uuid` as Row[];
 if(!intent)throw new Error('Bank allocation reversal intent not found');
 if(intent.legacy_journal_entry_id)return loadLegacyProvisionalReversal(ctx,id,intent,permit);
 const original=await loadBankAllocationOriginal(ctx,String(intent.original_intent_id));
 if(original.plan.bankTransactionId!==intent.bank_transaction_id)throw new Error('Reversal bank association changed');
 const periods=await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${company}::uuid AND start_date<=${intent.reversal_date}::date AND end_date>=${intent.reversal_date}::date ORDER BY id FOR UPDATE` as Row[];
 const vatLocks=await ctx.sql`SELECT * FROM vat_period_locks WHERE company_id=${company}::uuid AND period_start<=${intent.reversal_date}::date AND period_end>=${intent.reversal_date}::date ORDER BY id FOR SHARE` as Row[];
 const contras=await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${company}::uuid AND reversal_of_id=${original.journal.id}::uuid ORDER BY id FOR SHARE` as Row[];
 const facts={intent,original,periods,vatLocks,contras},fingerprint=createHash('sha256').update(canonicalJson(facts)).digest('hex');
 const effect=await loadIntentReceipt<{afterFingerprint:string;reversalJournalEntryId:string}>(ctx,{entityType:'bank_allocation_reversal_intent',entityId:id,operation:'bank_allocation.reverse'});
 if(effect){
  if(original.transfer)assertTransferBankLinks(original.transfer.banks,original.journal,original.lines,true);
  if(effect.result.afterFingerprint!==fingerprint||!original.journal.reversed_at||original.sources.bank.status!=='imported'
   ||!contras.some(j=>j.id===effect.result.reversalJournalEntryId&&j.status==='posted'))throw new Error('Bank reversal receipt changed');
 }else if(!permit&&(contras.some(j=>j.status==='posted')||original.journal.reversed_at))throw new Error('Bank allocation already reversed');
 return{kind:'receipt' as const,legacy:null,amount:String(original.intent.amount),...facts,fingerprint,effect};
}
/**
 * The same facts for a reversal whose original is a PROVEN legacy journal rather than a receipt: the journal, its
 * lines and the bank row the proof rests on, re-proven on every read, plus the same period, VAT-lock and contra facts.
 */
async function loadLegacyProvisionalReversal(ctx:ControlTx,id:string,intent:Row,permit?:ControlledEffectPermit){
 const company=ctx.principal.companyId;
 const {loadLegacyProvisionalOriginal}=await import('./bankAllocationLegacyProvisional');
 const effect=await loadIntentReceipt<{afterFingerprint:string;reversalJournalEntryId:string}>(ctx,{entityType:'bank_allocation_reversal_intent',entityId:id,operation:'bank_allocation.reverse'});
 const journalId=String(intent.legacy_journal_entry_id);
 const periods=await ctx.sql`SELECT * FROM fiscal_periods WHERE company_id=${company}::uuid AND start_date<=${String(intent.reversal_date)}::date AND end_date>=${String(intent.reversal_date)}::date ORDER BY id FOR UPDATE` as Row[];
 const vatLocks=await ctx.sql`SELECT * FROM vat_period_locks WHERE company_id=${company}::uuid AND period_start<=${String(intent.reversal_date)}::date AND period_end>=${String(intent.reversal_date)}::date ORDER BY id FOR SHARE` as Row[];
 const contras=await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${company}::uuid AND reversal_of_id=${journalId}::uuid ORDER BY id FOR SHARE` as Row[];
 // Once the reversal has happened the journal IS reversed and the bank row IS back in the queue, so the proof no
 // longer holds by construction: the executed state is checked instead. `permit` is the effect observing its own
 // work before its receipt exists; `effect` is every read after it was committed.
 if(effect||permit){
  const [journal]=await ctx.sql`SELECT id,entry_date::text AS entry_date,status,reversed_at FROM gl_journal_entries
   WHERE company_id=${company}::uuid AND id=${journalId}::uuid FOR SHARE` as Row[];
  const [bank]=await ctx.sql`SELECT * FROM bank_transactions WHERE company_id=${company}::uuid AND id=${String(intent.bank_transaction_id)}::uuid FOR SHARE` as Row[];
  const contra=contras.find(row=>row.status==='posted'&&(!effect||row.id===effect.result.reversalJournalEntryId));
  if(!journal||!journal.reversed_at||!bank||bank.status!=='imported'||bank.provisional_je_id!==null||!contra){
   throw new Error(effect?'Bank reversal receipt changed':'Bank reversal did not complete');
  }
  const facts={intent,legacy:{journal,bank},periods,vatLocks,contras};
  return{kind:'legacy' as const,intent,legacy:null,original:null,periods,vatLocks,contras,amount:new Decimal(String(bank.amount)).abs().toFixed(),
   fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex'),effect};
 }
 if(contras.some(row=>row.status==='posted'))throw new Error('Bank allocation already reversed');
 const legacy=await loadLegacyProvisionalOriginal(ctx,journalId);
 if(String(legacy.bank.id)!==String(intent.bank_transaction_id))throw new Error('Reversal bank association changed');
 const facts={intent,legacy:{journal:legacy.journal,bank:legacy.bank,lines:legacy.lines},periods,vatLocks,contras};
 return{kind:'legacy' as const,intent,legacy,original:null,periods,vatLocks,contras,amount:new Decimal(String(legacy.bank.amount)).abs().toFixed(),
  fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex'),effect};
}
export async function materializeBankAllocationReversal(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.entityType!=='bank_allocation_reversal_intent'||ref.operation!=='bank_allocation.reverse')throw new Error('Unsupported allocation reversal');
 const state=await loadBankAllocationReversal(ctx,ref.entityId);
 if(state.kind==='legacy')return legacyReversalMaterial(ctx,ref,state);
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
/** The binding for a proven-legacy reversal: the journal's own amount and date, and no beneficiary — it settles nothing. */
async function legacyReversalMaterial(ctx:ControlTx,ref:OperationRef,
 state:Extract<Awaited<ReturnType<typeof loadBankAllocationReversal>>,{kind:'legacy'}>):Promise<ApMaterial>{
 const prior=await readControlEntityVersion(ctx,ref);const {effect:_effect,...facts}=state;
 const parent={entityType:ref.entityType,entityId:ref.entityId,version:prior?.version??1,tracked:prior!==null,facts,
  fingerprint:createHash('sha256').update(canonicalJson(facts)).digest('hex')};
 if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Allocation reversal version changed');
 return{supplierId:'',observedSources:[parent],versionBasis:prior?'recorded_with_current_fingerprint':'untracked_current_observation',
  binding:{companyId:ctx.principal.companyId,entityType:ref.entityType,entityId:ref.entityId,operation:ref.operation,entityVersion:parent.version,
   accountingDate:String(state.intent.reversal_date),amount:state.amount,currency:'ZAR',beneficiaries:[],
   sourceVersions:[{entityType:parent.entityType,entityId:parent.entityId,version:parent.version,fingerprint:parent.fingerprint}]}};
}
