import type {ControlTx} from '../controls/contracts';
import {executeControlledOperation,assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {replayKnownOperationEffect} from '../controls/operationReceiptReplay';
import {loadInvoiceMatchOverride,withInvoiceMatchSourceLocks} from './invoiceMatchOverrideMaterial';
/** The kernel atomically stores this annotation as its immutable effect plus committed version/change event. */
export async function executeInvoiceMatchOverrideEffect(ctx:ControlTx,intentId:string,permit:ControlledEffectPermit){
 const ref={entityType:'invoice_match_override_intent',entityId:intentId,operation:'invoice_match.override' as const};
 assertControlledEffectPermit(ctx,permit,ref);
 const state=await loadInvoiceMatchOverride(ctx,intentId);
 if(state.intent.requester_person_id!==ctx.principal.personId||state.effect)throw new Error('Unexecuted override belonging to current requester required');
 return{intentId,invoiceId:state.intent.invoice_id,matchFingerprint:state.intent.expected_match_fingerprint,
  reason:state.intent.reason,evidenceRefs:state.evidence,status:'annotated' as const};
}
export async function executeInvoiceMatchOverride(ctx:ControlTx,intentId:string,approvalId?:string){
 return withInvoiceMatchSourceLocks(ctx,async()=>{
  const state=await loadInvoiceMatchOverride(ctx,intentId);
  if(state.intent.requester_person_id!==ctx.principal.personId)throw new Error('Invoice match override requester required');
  const ref={entityType:'invoice_match_override_intent',entityId:intentId,operation:'invoice_match.override' as const};
  if(state.effect)return replayKnownOperationEffect<Awaited<ReturnType<typeof executeInvoiceMatchOverrideEffect>>>(ctx,ref,state.effect.id);
  return executeControlledOperation(ctx,ref,approvalId??null,permit=>executeInvoiceMatchOverrideEffect(ctx,intentId,permit));
 });
}
