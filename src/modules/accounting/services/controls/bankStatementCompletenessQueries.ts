import type {ControlTx} from './contracts';
import {assertControlTx} from './context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {StatementObservation} from './bankStatementCompletenessAnalysis';
export interface BankStatementSource extends StatementObservation {population:string;currency:string;documentId:string|null;documentHash:string|null;version:number|null;sourceStatus:string|null}
/** Source import roots stay visible even when their account/document relationship is corrupt. */
export async function loadBankStatementCompleteness(ctx:ControlTx,cutoff:string|null){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:reports');await assertEffectivePermission(ctx,'read:bank-tx');
 const rows=await ctx.sql`WITH roots AS(
  SELECT s.id,s.bank_account_id,s.source_document_id,s.period_start,s.period_end,s.row_count,s.opening_balance,s.closing_balance,s.status
  FROM bank_statement_imports s WHERE s.company_id=${ctx.principal.companyId}::uuid
   AND (${cutoff}::date IS NULL OR s.period_end IS NULL OR s.period_end<=${cutoff}::date)
  UNION ALL
  SELECT a.id,a.id,NULL::uuid,NULL::date,NULL::date,NULL::integer,NULL::numeric,NULL::numeric,NULL::text
  FROM gl_accounts a WHERE a.company_id=${ctx.principal.companyId}::uuid AND a.account_subtype='bank'
   AND NOT EXISTS(SELECT 1 FROM bank_statement_imports s WHERE s.company_id=a.company_id AND s.bank_account_id=a.id
    AND (${cutoff}::date IS NULL OR s.period_end IS NULL OR s.period_end<=${cutoff}::date))
 ) SELECT r.id,a.id AS "accountId",r.period_start::text AS "periodStart",r.period_end::text AS "periodEnd",
 r.row_count AS "sourceCount",r.opening_balance::text AS opening,r.closing_balance::text AS closing,r.status AS "sourceStatus",
 c.default_currency AS currency,v.version,COUNT(*) OVER()::text AS population,
 (SELECT COUNT(*)::int FROM bank_transactions b WHERE b.company_id=${ctx.principal.companyId}::uuid AND b.bank_account_id=a.id
  AND b.transaction_date>=r.period_start AND b.transaction_date<=r.period_end) AS "importedCount",
 COALESCE((SELECT SUM(b.amount) FROM bank_transactions b WHERE b.company_id=${ctx.principal.companyId}::uuid AND b.bank_account_id=a.id
  AND b.transaction_date>=r.period_start AND b.transaction_date<=r.period_end),0)::text AS "importedNet",
 d.id AS "documentId",d.raw_bytes_sha256 AS "documentHash",
 COALESCE(d.raw_bytes IS NOT NULL AND octet_length(d.raw_bytes) BETWEEN 1 AND 10485760 AND d.status NOT IN ('deleted','rejected')
  AND encode(digest(d.raw_bytes,'sha256'),'hex')=d.raw_bytes_sha256,false) AS "sourceBytesVerified"
 FROM roots r JOIN companies c ON c.id=${ctx.principal.companyId}::uuid
 LEFT JOIN gl_accounts a ON a.company_id=c.id AND a.id=r.bank_account_id AND a.account_subtype='bank'
 LEFT JOIN captured_documents d ON d.company_id=c.id AND d.id=r.source_document_id
 LEFT JOIN control_entity_versions v ON v.company_id=c.id AND v.entity_type='bank_statement_import' AND v.entity_id=r.id::text
 ORDER BY r.id LIMIT 10001` as BankStatementSource[];
 return{rows:rows.slice(0,10000),populationCount:Number(rows[0]?.population??0),over:rows.length>10000};
}
