import {currentStatementReview} from './bankStatementReviewValidity';
import type {ControlTx} from './contracts';
import {assertStatementRead} from './bankStatementAttestationSource';
import type {StatementIntent} from './bankStatementAttestationMaterial';
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
  COALESCE(d.raw_bytes IS NOT NULL AND octet_length(d.raw_bytes) BETWEEN 1 AND 10485760 AND d.status NOT IN('deleted','rejected')
   AND encode(digest(d.raw_bytes,'sha256'),'hex')=i.expected_source_hash AND d.raw_bytes_sha256=i.expected_source_hash,false) AS bytes_verified,
  EXISTS(SELECT 1 FROM control_operation_decisions decision JOIN control_mandatory_statement_policies policy
   ON policy.company_id=decision.company_id AND policy.id::text=decision.policy_id
   WHERE decision.company_id=i.company_id AND decision.approval_id=a.id AND decision.decision='approved'
    AND decision.person_id<>i.requester_person_id) AS independent_decision
  FROM control_bank_statement_attestation_intents i
  JOIN control_operation_effects e ON e.company_id=i.company_id AND e.entity_type='bank_statement_attestation_intent'
   AND e.entity_id=i.id::text AND e.operation='bank_statement.attest'
  LEFT JOIN control_operation_approvals a ON a.company_id=i.company_id AND a.consumed_effect_id=e.id AND a.status='consumed'
   AND a.operation_id=e.operation_id AND a.entity_type=e.entity_type AND a.entity_id=e.entity_id AND a.operation=e.operation
   AND a.requester_person_id=i.requester_person_id
  JOIN companies c ON c.id=i.company_id
  LEFT JOIN gl_accounts b ON b.company_id=i.company_id AND b.id=i.bank_account_id
  LEFT JOIN captured_documents d ON d.company_id=i.company_id AND d.id=i.source_document_id
  LEFT JOIN control_entity_versions v ON v.company_id=i.company_id AND v.entity_type='bank_statement_attestation_intent' AND v.entity_id=i.id::text
  WHERE i.company_id=${ctx.principal.companyId}::uuid AND (${cutoff}::date IS NULL OR i.period_end<=${cutoff}::date)
  ORDER BY i.id,e.id LIMIT 10001` as ReviewRow[];
 return{populationCount:Number(rows[0]?.population??0),over:rows.length>10000,rows:rows.slice(0,10000).map(row=>{
  const active=currentStatementReview(row,!!row.approval_id&&row.independent_decision&&row.version!==null);
  return{row,active};
 })};
}
