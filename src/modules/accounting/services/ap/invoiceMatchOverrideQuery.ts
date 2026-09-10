import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {UUID_RE} from '@/lib/validation';
import {assertControlTx} from '../controls/context';
import type {ControlTx,EvidenceRef} from '../controls/contracts';
import {queryThreeWayMatch} from './threeWayMatchQueryService';
import {verifyInvoiceMatchEvidence} from './invoiceMatchOverrideMaterial';
import {canonicalIntentId,sameIntentId} from '../controls/intentIdentity';
interface AnnotationRow {id:string;reason:string;evidence_refs:EvidenceRef[];expected_match_fingerprint:string;effect_id:string|null;
 result:{intentId?:string;invoiceId?:string;matchFingerprint?:string}|null;approval_id:string|null;population_count:number;version:string|number|null}
/** A historical approved annotation never suppresses or changes the numeric matching result. */
export async function queryInvoiceMatchOverrides(ctx:ControlTx,rawInvoiceId:string){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:invoices');await assertEffectivePermission(ctx,'read:reports');
 if(!UUID_RE.test(rawInvoiceId))throw new Error('Invalid invoice match query');
 const invoiceId=canonicalIntentId(rawInvoiceId);
 const match=await queryThreeWayMatch(ctx,{invoiceId});
 const rows=await ctx.sql`SELECT i.id,i.reason,i.evidence_refs,i.expected_match_fingerprint,e.id AS effect_id,e.result,a.id AS approval_id,v.version,
  count(*) OVER()::int AS population_count FROM control_invoice_match_override_intents i
  LEFT JOIN LATERAL(SELECT ce.* FROM control_operation_effects ce WHERE ce.company_id=i.company_id
    AND ce.entity_type='invoice_match_override_intent' AND ce.entity_id_canonical=i.id::text AND ce.operation='invoice_match.override'
    ORDER BY (EXISTS(SELECT 1 FROM control_operation_approvals ca WHERE ca.company_id=ce.company_id AND ca.consumed_effect_id=ce.id AND ca.status='consumed')) DESC,
     (ce.entity_id=i.id::text) DESC,ce.committed_at,ce.id LIMIT 1) e ON true
  LEFT JOIN control_operation_approvals a ON a.company_id=i.company_id AND a.consumed_effect_id=e.id AND a.status='consumed'
   AND a.entity_type='invoice_match_override_intent' AND a.entity_id_canonical=i.id::text AND a.operation='invoice_match.override'
  LEFT JOIN LATERAL(SELECT cv.* FROM control_entity_versions cv WHERE cv.company_id=i.company_id
    AND cv.entity_type='invoice_match_override_intent' AND cv.entity_id_canonical=i.id::text
    ORDER BY cv.version DESC,(cv.entity_id=i.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
  WHERE i.company_id=${ctx.principal.companyId}::uuid AND i.invoice_id=${invoiceId}::uuid ORDER BY i.created_at DESC,i.id LIMIT 101` as AnnotationRow[];
 const populationCount=rows[0]?.population_count??0,missing:string[]=[];
 if(populationCount>100)missing.push('override_annotation_population_exceeds_100');
 const overrides=[];
 for(const row of rows.slice(0,100)){
  let state:'pending'|'active'|'stale'=row.effect_id?'active':'pending';
  const reasons:string[]=[],safeEvidence:EvidenceRef[]=[];
  try{safeEvidence.push(...await verifyInvoiceMatchEvidence(ctx,invoiceId,row.evidence_refs));}catch(error){
   if(!(error instanceof Error)||!['Override evidence bytes unavailable or changed','Same-invoice captured override evidence required','Override evidence required'].includes(error.message))throw error;
   reasons.push('override_evidence_changed');
  }
  if(row.effect_id){
   if(!row.approval_id||!sameIntentId(row.result?.intentId,row.id)||!sameIntentId(row.result?.invoiceId,invoiceId)||row.result?.matchFingerprint!==row.expected_match_fingerprint)
    reasons.push('approved_annotation_provenance_unavailable');
   if(match.over||!match.results.length||row.expected_match_fingerprint!==match.materialFingerprint)reasons.push('match_material_changed');
   if(reasons.length)state='stale';
  }
  overrides.push({intentId:row.id,state,reason:row.reason,evidenceRefs:safeEvidence,version:row.version===null?null:Number(row.version),staleReasons:reasons});
 }
 return{invoiceId,materialFingerprint:match.materialFingerprint,matchResults:match.results.map(r=>({itemId:r.row.item_id,match:r.match,missing:r.missing,excluded:r.excluded})),
  overrides,populationCount,missingSources:missing};
}
