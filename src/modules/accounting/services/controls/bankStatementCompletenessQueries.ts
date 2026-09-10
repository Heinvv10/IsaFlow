import {currentStatementReview,type StatementReviewProof} from './bankStatementReviewValidity';
import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {StatementObservation} from './bankStatementCompletenessAnalysis';
import {scanCapturedEvidence} from './capturedEvidenceScan';
export interface BankStatementSource extends StatementObservation {population:string;currency:string;documentId:string|null;documentHash:string|null;version:number|null;sourceStatus:string|null;importedFingerprint:string;entityType:string;reviewState:'active'|'stale'|'deferred'|null}
/** Source import roots stay visible even when their account/document relationship is corrupt. */
export async function loadBankStatementCompleteness(ctx:ControlTx,cutoff:string|null){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:reports');await assertEffectivePermission(ctx,'read:bank-tx');
 const rows=await ctx.sql`WITH reviewed AS(
  SELECT i.*,e.result,e.id AS effect_id,a.id IS NOT NULL AND EXISTS(
   SELECT 1 FROM control_operation_decisions decision JOIN control_mandatory_statement_policies policy
    ON policy.company_id=decision.company_id AND policy.id::text=decision.policy_id
   WHERE decision.company_id=i.company_id AND decision.approval_id=a.id AND decision.decision='approved'
    AND decision.person_id<>i.requester_person_id) AS review_valid
  FROM control_bank_statement_attestation_intents i
  JOIN control_operation_effects e ON e.company_id=i.company_id AND e.entity_type='bank_statement_attestation_intent'
   AND lower(e.entity_id)=i.id::text AND e.operation='bank_statement.attest'
  LEFT JOIN control_operation_approvals a ON a.company_id=i.company_id AND a.consumed_effect_id=e.id AND a.status='consumed'
   AND a.operation_id=e.operation_id AND a.entity_type=e.entity_type AND lower(a.entity_id)=lower(e.entity_id) AND a.operation=e.operation
   AND a.requester_person_id=i.requester_person_id
  WHERE i.company_id=${ctx.principal.companyId}::uuid AND (${cutoff}::date IS NULL OR i.period_end<=${cutoff}::date)
 ),roots AS(
  SELECT s.id,s.bank_account_id,s.source_document_id,s.period_start,s.period_end,s.row_count,s.opening_balance,s.closing_balance,s.status,
   'bank_statement_import'::text AS entity_type,NULL::text AS source_fingerprint,NULL::text AS expected_source_hash,
   NULL::text AS review_currency,NULL::jsonb AS review_result,false AS review_valid
  FROM bank_statement_imports s WHERE s.company_id=${ctx.principal.companyId}::uuid
   AND (${cutoff}::date IS NULL OR s.period_end IS NULL OR s.period_end<=${cutoff}::date)
   AND NOT EXISTS(SELECT 1 FROM reviewed i WHERE i.bank_account_id=s.bank_account_id AND i.source_document_id=s.source_document_id
    AND i.period_start=s.period_start AND i.period_end=s.period_end)
  UNION ALL
  SELECT i.id,i.bank_account_id,i.source_document_id,i.period_start,i.period_end,i.source_count,i.opening_balance,i.closing_balance,
   'locally_reviewed','bank_statement_attestation_intent',i.source_fingerprint,i.expected_source_hash,i.currency,i.result,i.review_valid FROM reviewed i
  UNION ALL
  SELECT a.id,a.id,NULL::uuid,NULL::date,NULL::date,NULL::integer,NULL::numeric,NULL::numeric,NULL::text,
   'bank_statement_import',NULL::text,NULL::text,NULL::text,NULL::jsonb,false
  FROM gl_accounts a WHERE a.company_id=${ctx.principal.companyId}::uuid AND a.account_subtype='bank'
   AND NOT EXISTS(SELECT 1 FROM reviewed i WHERE i.bank_account_id=a.id)
   AND NOT EXISTS(SELECT 1 FROM bank_statement_imports s WHERE s.company_id=a.company_id AND s.bank_account_id=a.id
    AND (${cutoff}::date IS NULL OR s.period_end IS NULL OR s.period_end<=${cutoff}::date))
 ),uncovered AS(
  SELECT b.id,b.bank_account_id,b.transaction_date,b.amount FROM bank_transactions b
  WHERE b.company_id=${ctx.principal.companyId}::uuid AND (${cutoff}::date IS NULL OR b.transaction_date IS NULL OR b.transaction_date<=${cutoff}::date)
   AND NOT EXISTS(SELECT 1 FROM roots source JOIN gl_accounts owned ON owned.company_id=b.company_id AND owned.id=source.bank_account_id
    AND owned.account_subtype='bank' WHERE owned.id=b.bank_account_id AND b.transaction_date BETWEEN source.period_start AND source.period_end)
 ) SELECT r.id,a.id AS "accountId",r.period_start::text AS "periodStart",r.period_end::text AS "periodEnd",
 r.row_count AS "sourceCount",r.opening_balance::text AS opening,r.closing_balance::text AS closing,r.status AS "sourceStatus",
 c.default_currency AS currency,v.version,COUNT(*) OVER()::text AS population,r.entity_type AS "entityType",
 r.bank_account_id,r.source_document_id,r.source_fingerprint,r.expected_source_hash,r.review_currency,r.review_result,r.review_valid,
 a.account_type,a.account_subtype,a.is_active,
 (SELECT COUNT(*)::text FROM uncovered) AS "uncoveredCount",
 (SELECT encode(digest(COALESCE(string_agg(to_jsonb(u)::text,',' ORDER BY u.id),''),'sha256'),'hex')
  FROM(SELECT * FROM uncovered ORDER BY id LIMIT 10001) u) AS "uncoveredFingerprint",
 (SELECT COUNT(*)::int FROM bank_transactions b WHERE b.company_id=${ctx.principal.companyId}::uuid AND b.bank_account_id=a.id
  AND b.transaction_date>=r.period_start AND b.transaction_date<=r.period_end) AS "importedCount",
 COALESCE((SELECT SUM(b.amount) FROM bank_transactions b WHERE b.company_id=${ctx.principal.companyId}::uuid AND b.bank_account_id=a.id
  AND b.transaction_date>=r.period_start AND b.transaction_date<=r.period_end),0)::text AS "importedNet",
 (SELECT encode(digest(COALESCE(string_agg(f.id::text||':'||f.amount::text||':'||f.transaction_date::text,',' ORDER BY f.id),''),'sha256'),'hex')
  FROM(SELECT b.id,b.amount,b.transaction_date FROM bank_transactions b WHERE b.company_id=${ctx.principal.companyId}::uuid
   AND b.bank_account_id=a.id AND b.transaction_date>=r.period_start AND b.transaction_date<=r.period_end ORDER BY b.id LIMIT 10001) f) AS "importedFingerprint",
 d.id AS "documentId",d.raw_bytes_sha256 AS "documentHash",d.status AS document_status,
 false AS "sourceBytesVerified"
 FROM roots r JOIN companies c ON c.id=${ctx.principal.companyId}::uuid
 LEFT JOIN gl_accounts a ON a.company_id=c.id AND a.id=r.bank_account_id AND a.account_subtype='bank'
 LEFT JOIN captured_documents d ON d.company_id=c.id AND d.id=r.source_document_id
 LEFT JOIN LATERAL(SELECT cv.* FROM control_entity_versions cv WHERE cv.company_id=c.id AND cv.entity_type=r.entity_type AND lower(cv.entity_id)=r.id::text ORDER BY (cv.entity_id=r.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
 ORDER BY r.id LIMIT 10001` as (BankStatementSource&{bank_account_id:string;source_document_id:string;source_fingerprint:string;expected_source_hash:string;
  review_currency:string;review_result:StatementReviewProof['result'];review_valid:boolean;account_type:string|null;account_subtype:string|null;
  is_active:boolean|null;document_status:string|null;uncoveredCount:string;uncoveredFingerprint:string})[];
 const evidence=await scanCapturedEvidence(ctx,rows.length>10000?[]:rows.map(row=>row.documentId),'read:bank-tx');
 const deferred=evidence.evidenceMissing.some(reason=>reason.startsWith('async_scan_required:'));
 return{evidenceMissing:evidence.evidenceMissing,rows:rows.slice(0,10000).map(row=>{
  row.sourceBytesVerified=row.documentId!==null&&row.documentHash!==null&&evidence.verified.get(row.documentId)===row.documentHash;
  const reviewed=row.entityType==='bank_statement_attestation_intent';
  const independentlyReviewed=reviewed&&currentStatementReview({...row,currency:row.review_currency,current_currency:row.currency,
   document_id:row.documentId,document_hash:row.documentHash,bytes_verified:row.sourceBytesVerified,result:row.review_result},row.review_valid&&row.version!==null);
  return{...row,independentlyReviewed,reviewState:reviewed?(independentlyReviewed?'active' as const:deferred?'deferred' as const:'stale' as const):null};
 }),populationCount:Number(rows[0]?.population??0),over:rows.length>10000,uncoveredCount:Number(rows[0]?.uncoveredCount??0)};
}
