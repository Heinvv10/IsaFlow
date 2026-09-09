import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import type {ProtectedChange} from './changeProtection';
import {RISK_SOURCE_LIMIT} from './invoiceRiskQueriesResult';
export interface RiskBeneficiaryRow {id:string;version_id:string|null;version:number|string|null;fingerprint:string|null;details_envelope:ProtectedChange|null;
 bank_name:string|null;bank_account_number:string|null;bank_branch_code:string|null;bank_account_type:string|null;pending:boolean;verified_at:string|null}
/** Caller must check the same current write:bank-tx authority used by getVerifiedBeneficiary before this sensitive query. */
export async function loadRiskBeneficiaries(ctx:ControlTx){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:bank-tx');
 const rows=await ctx.sql`SELECT s.id,s.bank_name,s.bank_account_number,s.bank_branch_code,s.bank_account_type,b.id AS version_id,b.version,b.fingerprint,b.details_envelope,b.verified_at::text,
  EXISTS(SELECT 1 FROM control_beneficiary_proposals p WHERE p.company_id=s.company_id AND p.entity_type='supplier' AND p.entity_id=s.id AND p.status='pending') AS pending,
  count(*) OVER()::int AS population_count FROM suppliers s
  LEFT JOIN LATERAL (SELECT * FROM control_beneficiary_versions b WHERE b.company_id=s.company_id AND b.entity_type='supplier' AND b.entity_id=s.id ORDER BY b.version DESC LIMIT 1) b ON true
  WHERE s.company_id=${ctx.principal.companyId}::uuid ORDER BY s.id LIMIT ${RISK_SOURCE_LIMIT+1}` as Array<RiskBeneficiaryRow&{population_count:number}>;
 return{rows:rows.map(({population_count:_count,...row})=>row),populationCount:rows[0]?.population_count??0};
}
