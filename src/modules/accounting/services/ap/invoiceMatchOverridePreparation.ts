import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {z} from 'zod';
const evidence=z.object({store:z.literal('captured'),evidenceId:z.string().uuid(),entityType:z.literal('supplier_invoice'),
 entityId:z.string().uuid(),version:z.null(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const schema=z.object({invoiceId:z.string().uuid(),expectedMatchFingerprint:z.string().regex(/^[a-f0-9]{64}$/),
 reason:z.string().trim().min(1).max(1000),evidenceRefs:z.array(evidence).min(1).max(20)}).strict();
export function parseInvoiceMatchOverride(input:unknown){
 const parsed=schema.parse(input);
 if(parsed.evidenceRefs.some(ref=>ref.entityId!==parsed.invoiceId)||new Set(parsed.evidenceRefs.map(ref=>ref.evidenceId)).size!==parsed.evidenceRefs.length)
  throw new Error('Distinct same-invoice override evidence required');
 return parsed;
}

import {randomUUID} from 'node:crypto';
import type {ControlTx} from '../controls/contracts';
import {recordCommittedChange} from '../controls/changeEventService';
import {loadInvoiceMatchCurrent,verifyInvoiceMatchEvidence,withInvoiceMatchSourceLocks} from './invoiceMatchOverrideMaterial';
/** Requires current invoice read and write authority; no journal posting authority is required. */
export async function prepareInvoiceMatchOverride(ctx:ControlTx,input:unknown){
 await assertEffectivePermission(ctx,'write:invoices');
 const parsed=parseInvoiceMatchOverride(input);
 return withInvoiceMatchSourceLocks(ctx,async()=>{
  const current=await loadInvoiceMatchCurrent(ctx,parsed.invoiceId);
  if(current.match.materialFingerprint!==parsed.expectedMatchFingerprint)throw new Error('Invoice match material changed');
  if(!current.match.results.some(r=>r.missing.length||r.match?.mismatches.length))throw new Error('Invoice has no current match exception');
  const evidence=await verifyInvoiceMatchEvidence(ctx,parsed.invoiceId,parsed.evidenceRefs),id=randomUUID();
  await ctx.sql`INSERT INTO control_invoice_match_override_intents(company_id,id,requester_person_id,invoice_id,expected_match_fingerprint,reason,evidence_refs)
   VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${ctx.principal.personId},${parsed.invoiceId}::uuid,${current.match.materialFingerprint},${parsed.reason},${JSON.stringify(evidence)}::jsonb)`;
  await recordCommittedChange(ctx,{entityType:'invoice_match_override_intent',entityId:id,previousVersion:null,newVersion:1,
   action:'invoice_match.override_prepared',accountingDate:current.invoice.invoice_date,before:null,
   after:{invoiceId:parsed.invoiceId,expectedMatchFingerprint:current.match.materialFingerprint,reason:parsed.reason,evidenceRefs:evidence},bindingHash:null,protectedEvidenceRef:null});
  return{intentId:id,operation:{entityType:'invoice_match_override_intent',entityId:id,operation:'invoice_match.override' as const}};
 });
}
