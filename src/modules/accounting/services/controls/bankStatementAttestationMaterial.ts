import type {ControlTx,OperationRef} from './contracts';
import type {ApMaterial} from './apOperationMaterializer';
import {canonicalMoney} from './canonical';
import {canonicalIntentId,loadIntentReceipt} from './intentIdentity';
import {readControlEntityVersion} from './operationVersions';
import {riskHash} from './invoiceRiskQueriesResult';
import {assertStatementRead,loadBankStatementSource,withStatementSourceLocks} from './bankStatementAttestationSource';
export interface StatementIntent {
 id:string;requester_person_id:string;bank_account_id:string;source_document_id:string;expected_source_hash:string;source_fingerprint:string;
 period_start:string;period_end:string;source_count:number;opening_balance:string;closing_balance:string;currency:string;created_at:Date|string;
}
export async function loadBankStatementAttestation(ctx:ControlTx,inputId:string){
 await assertStatementRead(ctx);
 const id=canonicalIntentId(inputId);
 const [intent]=await ctx.sql`SELECT id,requester_person_id,bank_account_id,source_document_id,expected_source_hash,source_fingerprint,
  period_start::text,period_end::text,source_count,opening_balance::text,closing_balance::text,currency,created_at
  FROM control_bank_statement_attestation_intents WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid` as StatementIntent[];
 if(!intent)throw new Error('Owned bank statement attestation intent required');
 const source=await loadBankStatementSource(ctx,intent.bank_account_id,intent.source_document_id,intent.expected_source_hash);
 if(source.fingerprint!==intent.source_fingerprint||source.currency!==intent.currency)throw new Error('Statement attestation source changed');
 // A receipt written before entity_id normalization keeps its original spelling.
 const effect=await loadIntentReceipt<unknown>(ctx,{entityType:'bank_statement_attestation_intent',entityId:id,operation:'bank_statement.attest'});
 return{intent,source,effect:effect??null};
}
export async function materializeBankStatementAttestation(ctx:ControlTx,ref:OperationRef):Promise<ApMaterial>{
 if(ref.operation!=='bank_statement.attest'||ref.entityType!=='bank_statement_attestation_intent')throw new Error('Unsupported bank statement attestation');
 return withStatementSourceLocks(ctx,async()=>{
  const state=await loadBankStatementAttestation(ctx,ref.entityId),prior=await readControlEntityVersion(ctx,ref);
  const facts={...state},parent={entityType:ref.entityType,entityId:ref.entityId,version:prior?.version??1,tracked:prior!==null,facts,fingerprint:riskHash(facts)};
  if(ref.expectedVersion!==undefined&&ref.expectedVersion!==parent.version)throw new Error('Statement attestation version changed');
  return{supplierId:'',observedSources:[parent],versionBasis:prior?'recorded_with_current_fingerprint':'untracked_current_observation',
   binding:{companyId:ctx.principal.companyId,operation:ref.operation,entityType:ref.entityType,entityId:ref.entityId,entityVersion:parent.version,
    accountingDate:state.intent.period_end,amount:canonicalMoney('0'),currency:state.intent.currency,beneficiaries:[],
    sourceVersions:[{entityType:parent.entityType,entityId:parent.entityId,version:parent.version,fingerprint:parent.fingerprint}]}};
 });
}
