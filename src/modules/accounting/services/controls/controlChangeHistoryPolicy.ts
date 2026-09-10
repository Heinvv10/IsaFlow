import {UUID_RE,isRealCalendarDate} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from './contracts';
import {approvalOperationNames,operationPermission} from './operationPermissions';
import {readHistoricalImportSourceKind} from './historicalImportSourceKind';
import {hasHistoryParent} from './controlChangeHistoryParents';
const domains:Record<string,string>={
 supplier:'read:contacts',customer:'read:contacts',beneficiary_supplier:'read:contacts',beneficiary_supplier_proposal:'read:contacts',
 supplier_invoice:'read:invoices',sage_supplier_invoice:'read:invoices',customer_invoice:'read:invoices',credit_note:'read:invoices',credit_note_application:'read:invoices',recurring_invoice_run:'read:invoices',purchase_order:'read:invoices',goods_received_note:'read:invoices',invoice_match_override_intent:'read:invoices',
 supplier_payment:'read:bank-tx',supplier_payment_batch:'read:bank-tx',customer_payment:'read:bank-tx',bank_transaction:'read:bank-tx',bank_rule:'read:bank-tx',bank_categorisation_rule:'read:bank-tx',bank_allocation_intent:'read:bank-tx',bank_allocation_reversal_intent:'read:bank-tx',cash_application_intent:'read:bank-tx',cash_application_reversal_intent:'read:bank-tx',bank_transfer_intent:'read:bank-tx',payment_preparation:'read:bank-tx',payment_release_intent:'read:bank-tx',bank_statement_attestation_intent:'read:bank-tx',
 gl_account:'read:reports',journal_entry:'read:reports',fiscal_period:'read:reports',fiscal_year:'read:reports',company:'read:reports',company_gl_settings:'read:reports',accounting_default_accounts:'read:reports',company_lockdown_intent:'read:reports',vat_period:'read:vat',
 employee:'read:payroll',payroll_run:'read:payroll',payroll_employee_component:'read:payroll',payroll_compensation_intent:'read:payroll',employee_beneficiary_evidence:'read:payroll',beneficiary_employee:'read:payroll',beneficiary_employee_proposal:'read:payroll',
 asset:'read:assets',asset_depreciation_intent:'read:assets',historical_import:'read:imports',historical_import_source:'read:imports',operation_approval:'read:approvals',
};
export const HISTORY_ENTITY_TYPES=Object.freeze(Object.keys(domains));
export function historyDomain(type:string){if(!Object.hasOwn(domains,type))throw new Error('Unsupported history entity family');return domains[type]!;}
export async function assertHistoryEntity(ctx:ControlTx,type:string,id:string){
 const dates=id.split('/');
 if(type==='fiscal_year'?!/^[1-9][0-9]{3}$/.test(id):type==='vat_period'?!(dates.length===2&&dates.every(isRealCalendarDate)&&dates[0]!<=dates[1]!):!UUID_RE.test(id))throw new Error('Invalid history entity identity');
 await assertEffectivePermission(ctx,'read:audit');await assertEffectivePermission(ctx,historyDomain(type));
 const c=ctx.principal.companyId;
 if(type==='operation_approval'){
  const rows=await ctx.sql`SELECT operation FROM control_operation_approvals WHERE company_id=${c}::uuid AND id::text=${id}` as {operation:string}[];
  if(rows.length!==1)throw new Error('History unavailable');await assertEffectivePermission(ctx,operationPermission(rows[0]!.operation,'read'));
 }
 if(type==='historical_import'||type==='historical_import_source'){
  const rows=await ctx.sql`SELECT DISTINCT kind FROM control_historical_imports WHERE company_id=${c}::uuid
   AND ((${type}='historical_import' AND id::text=${id}) OR (${type}='historical_import_source' AND source_id::text=${id})) LIMIT 5` as {kind:string}[];
  if(type==='historical_import_source'){
   const kind=await readHistoricalImportSourceKind(ctx,id);
   if(kind)rows.push({kind});
  }
  if(!rows.length)throw new Error('History domain metadata unavailable');
  for(const row of rows){if(!['gl','opening_balance','customer_invoice','supplier_invoice'].includes(row.kind))throw new Error('Unsupported import history');await assertEffectivePermission(ctx,['gl','opening_balance'].includes(row.kind)?'read:reports':'read:invoices');}
 }
 const retained=await ctx.sql`SELECT id FROM control_change_events WHERE company_id=${c}::uuid AND entity_type=${type} AND lower(entity_id)=lower(${id}) LIMIT 1`;
 if(!retained.length&&!await hasHistoryParent(ctx,type,id))throw new Error('History unavailable');
}
/** Project a finite authority vocabulary in SQL; never transfer whole binding populations. */
export async function assertHistoryOperationSources(ctx:ControlTx,operationIds:string[]){
 if(!operationIds.length)return;
 const c=ctx.principal.companyId;
 const rows=await ctx.sql`WITH base AS (
  SELECT operation,entity_type,entity_id,
   CASE WHEN jsonb_typeof(binding->'sourceVersions')='array' AND jsonb_typeof(binding->'beneficiaries')='array'
    THEN (binding->'sourceVersions')||(binding->'beneficiaries') ELSE '[{"entityType":"unsupported"}]'::jsonb END AS sources
  FROM control_operation_approvals WHERE company_id=${c}::uuid AND operation_id=ANY(${operationIds}::uuid[])
  UNION ALL SELECT operation,entity_type,entity_id,'[]'::jsonb FROM control_operation_effects
   WHERE company_id=${c}::uuid AND operation_id=ANY(${operationIds}::uuid[])
 ), refs AS (
  SELECT source->>'entityType' AS kind,source->>'entityId' AS id FROM base CROSS JOIN LATERAL jsonb_array_elements(sources) source
  UNION ALL SELECT entity_type,entity_id FROM base WHERE operation='historical_import.post'
 ), requirements AS (
  SELECT 'operation' AS category,CASE WHEN operation=ANY(${approvalOperationNames()}::text[]) THEN operation ELSE 'unsupported' END AS value FROM base
  UNION ALL SELECT 'family',CASE WHEN kind=ANY(${HISTORY_ENTITY_TYPES}::text[]) AND kind<>'operation_approval' THEN kind ELSE 'unsupported' END FROM refs
  UNION ALL SELECT 'family',CASE WHEN imports.kind IN ('gl','opening_balance') THEN 'gl_account'
    WHEN imports.kind IN ('customer_invoice','supplier_invoice') THEN 'supplier_invoice' ELSE 'unsupported' END
   FROM refs LEFT JOIN control_historical_imports imports ON imports.company_id=${c}::uuid
    AND ((refs.kind='historical_import' AND imports.id::text=refs.id)
     OR (refs.kind='historical_import_source' AND imports.source_id::text=refs.id))
   WHERE refs.kind IN ('historical_import','historical_import_source')
 ) SELECT DISTINCT category,value FROM requirements` as {category:string;value:string}[];
 const needed=new Set<string>();
 for(const row of rows){
  if(row.value==='unsupported')throw new Error('History source metadata unavailable');
  needed.add(row.category==='operation'?operationPermission(row.value,'read'):historyDomain(row.value));
 }
 for(const permission of needed)await assertEffectivePermission(ctx,permission);
}
