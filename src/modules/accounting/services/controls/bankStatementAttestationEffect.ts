import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from './contracts';
import {executeControlledOperation,assertControlledEffectPermit,type ControlledEffectPermit} from './approvalExecutionService';
import {replayKnownOperationEffect} from './operationReceiptReplay';
import {loadBankStatementAttestation} from './bankStatementAttestationMaterial';
import {withStatementSourceLocks} from './bankStatementAttestationSource';
import {canonicalIntentId} from './intentIdentity';
export async function executeBankStatementAttestationEffect(ctx:ControlTx,intentId:string,permit:ControlledEffectPermit){
 const ref={entityType:'bank_statement_attestation_intent',entityId:intentId,operation:'bank_statement.attest' as const};
 assertControlledEffectPermit(ctx,permit,ref);
 const state=await loadBankStatementAttestation(ctx,intentId);
 if(state.intent.requester_person_id!==ctx.principal.personId||state.effect)throw new Error('Unexecuted statement attestation belonging to requester required');
 return{intentId,bankAccountId:state.intent.bank_account_id,sourceDocumentId:state.intent.source_document_id,sourceHash:state.intent.expected_source_hash,
  sourceFingerprint:state.intent.source_fingerprint,status:'locally_reviewed' as const,coverage:['external_bank_confirmation_not_performed']};
}
/** A completed effect records an independent local review; it does not assert external bank authenticity. */
export async function executeBankStatementAttestation(ctx:ControlTx,inputIntentId:string,approvalId?:string){
 await assertEffectivePermission(ctx,'write:bank-tx');
 // One spelling for the receipt read, the control ref and the recorded result.
 const intentId=canonicalIntentId(inputIntentId);
 return withStatementSourceLocks(ctx,async()=>{
  const state=await loadBankStatementAttestation(ctx,intentId);
  if(state.intent.requester_person_id!==ctx.principal.personId)throw new Error('Statement attestation requester required');
  const ref={entityType:'bank_statement_attestation_intent',entityId:intentId,operation:'bank_statement.attest' as const};
  // Only an unapproved retry replays. A caller presenting its own approval goes to the
  // kernel, which fails closed on the committed effect instead of silently consuming nothing.
  if(state.effect&&!approvalId)return replayKnownOperationEffect<Awaited<ReturnType<typeof executeBankStatementAttestationEffect>>>(ctx,ref,state.effect.id);
  return executeControlledOperation(ctx,ref,approvalId??null,permit=>executeBankStatementAttestationEffect(ctx,intentId,permit));
 });
}
