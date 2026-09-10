import {currentStatementReview} from './bankStatementReviewValidity';
import type {ControlTx} from './contracts';
import {assertStatementRead} from './bankStatementAttestationSource';
import type {StatementIntent} from './bankStatementAttestationMaterial';
import {scanCapturedEvidence} from './capturedEvidenceScan';
interface ReviewRow extends StatementIntent {
 population:string;effect_id:string;approval_id:string|null;version:string|null;
 result:{intentId?:string;sourceHash?:string;sourceFingerprint?:string;bankAccountId?:string;sourceDocumentId?:string;status?:string};
 account_type:string|null;account_subtype:string|null;is_active:boolean|null;current_currency:string;
 document_id:string|null;document_status:string|null;document_hash:string|null;bytes_verified:boolean;independent_decision:boolean;
}
/** Completed local review provenance is historical; current source bytes/account/currency are rechecked on every report. */
export async function queryVerifiedBankStatements(ctx:ControlTx,cutoff:string|null){
 await assertStatementRead(ctx);
 const rows=await ctx.sql`SELECT i.*,i.period_start::text,i.period_end::text,i.opening_balance::text,i.closing_balance::text,
  COUNT(*) OVER()::text AS population,e.id AS effect_id,e.result,a.id AS approval_id,v.version,
  b.account_type,b.account_subtype,b.is_active,c.default_currency AS current_currency,
  d.id AS document_id,d.status AS document_status,d.raw_bytes_sha256 AS document_hash,
  false AS bytes_verified,
  EXISTS(SELECT 1 FROM control_operation_decisions decision JOIN control_mandatory_statement_policies policy
   ON policy.company_id=decision.company_id AND policy.id::text=decision.policy_id
   WHERE decision.company_id=i.company_id AND decision.approval_id=a.id AND decision.decision='approved'
    AND decision.person_id<>i.requester_person_id) AS independent_decision
  FROM control_bank_statement_attestation_intents i
  JOIN LATERAL(SELECT ce.* FROM control_operation_effects ce WHERE ce.company_id=i.company_id
    AND ce.entity_type='bank_statement_attestation_intent' AND ce.entity_id_canonical=i.id::text AND ce.operation='bank_statement.attest'
    ORDER BY (EXISTS(SELECT 1 FROM control_operation_approvals ca WHERE ca.company_id=ce.company_id AND ca.consumed_effect_id=ce.id AND ca.status='consumed')) DESC,
     (ce.entity_id=i.id::text) DESC,ce.committed_at,ce.id LIMIT 1) e ON true
  LEFT JOIN control_operation_approvals a ON a.company_id=i.company_id AND a.consumed_effect_id=e.id AND a.status='consumed'
   AND a.operation_id=e.operation_id AND a.entity_type=e.entity_type AND a.entity_id_canonical=e.entity_id_canonical AND a.operation=e.operation
   AND a.requester_person_id=i.requester_person_id
  JOIN companies c ON c.id=i.company_id
  LEFT JOIN gl_accounts b ON b.company_id=i.company_id AND b.id=i.bank_account_id
  LEFT JOIN captured_documents d ON d.company_id=i.company_id AND d.id=i.source_document_id
  LEFT JOIN LATERAL(SELECT cv.* FROM control_entity_versions cv WHERE cv.company_id=i.company_id
    AND cv.entity_type='bank_statement_attestation_intent' AND cv.entity_id_canonical=i.id::text
    ORDER BY cv.version DESC,(cv.entity_id=i.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
  WHERE i.company_id=${ctx.principal.companyId}::uuid AND (${cutoff}::date IS NULL OR i.period_end<=${cutoff}::date)
  ORDER BY i.id,e.id LIMIT 10001` as ReviewRow[];
 const evidence=await scanCapturedEvidence(ctx,rows.length>10000?[]:rows.map(row=>row.document_id),'read:bank-tx');
 return{evidenceMissing:evidence.evidenceMissing,populationCount:Number(rows[0]?.population??0),over:rows.length>10000,rows:rows.slice(0,10000).map(row=>{
  row.bytes_verified=row.document_id!==null&&row.document_hash===row.expected_source_hash&&evidence.verified.get(row.document_id)===row.expected_source_hash;
  const active=currentStatementReview(row,!!row.approval_id&&row.independent_decision&&row.version!==null);
  return{row,active};
 })};
}
