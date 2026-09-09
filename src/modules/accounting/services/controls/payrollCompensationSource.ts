import {assertControlTx} from './context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {canonicalJson} from './canonical';
import {createHash} from 'node:crypto';
import type {ControlTx} from './contracts';
import type {PayrollCompensationPayload,PayrollCompensationAction} from './payrollCompensationPlan';
export type CompensationRow=Record<string,unknown>;
export interface CompensationSources {company:CompensationRow;employees:CompensationRow[];components:CompensationRow[];assignments:CompensationRow[];runs:CompensationRow[];versions:CompensationRow[];sourceHeader:CompensationRow|null;sourceLines:CompensationRow[]}
export const compensationFingerprint=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Existing631 payroll population fence plus source-parent locks prevent unseen inserted child rows. */
export async function loadPayrollCompensationSources(ctx:ControlTx,source:PayrollCompensationPayload['source']):Promise<CompensationSources>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:payroll');const company=ctx.principal.companyId;
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-payroll:${company}`},0))`;
 const [companyRow]=await ctx.sql`SELECT id,default_currency,lockdown_enabled,lockdown_date::text FROM companies WHERE id=${company}::uuid FOR SHARE` as CompensationRow[];
 if(!companyRow||companyRow.default_currency!=='ZAR')throw new Error('Owned ZAR payroll company required');
 const employees=await ctx.sql`SELECT id,status,start_date::text,end_date::text FROM payroll_employees WHERE company_id=${company}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as CompensationRow[];
 const components=await ctx.sql`SELECT id,name,sars_source_code,component_type,is_taxable,is_uif_applicable,is_sdl_applicable,is_active FROM payroll_components WHERE company_id=${company}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as CompensationRow[];
 const assignments=await ctx.sql`SELECT a.id,a.employee_id,a.component_id,a.amount::text,a.effective_from::text,a.effective_to::text,a.is_recurring,a.created_at
  FROM payroll_employee_components a JOIN payroll_employees e ON e.id=a.employee_id AND e.company_id=${company}::uuid ORDER BY a.id LIMIT 10001 FOR UPDATE OF a` as CompensationRow[];
 const runs=await ctx.sql`SELECT id,period_year,period_month,status FROM payroll_run_headers WHERE company_id=${company}::uuid ORDER BY id LIMIT 10001 FOR SHARE` as CompensationRow[];
 const versions=await ctx.sql`SELECT entity_id,version,material_hash FROM control_entity_versions WHERE company_id=${company}::uuid AND entity_type='payroll_employee_component' ORDER BY entity_id LIMIT 10001 FOR SHARE` as CompensationRow[];
 let sourceHeader:CompensationRow|null=null,sourceLines:CompensationRow[]=[];
 if(source.kind==='package'){
  const rows=await ctx.sql`SELECT * FROM pay_packages WHERE company_id=${company}::uuid AND id=${source.sourceId}::uuid FOR UPDATE` as CompensationRow[];
  sourceHeader=rows[0]??null;if(!sourceHeader)throw new Error('Owned pay package required');
  sourceLines=await ctx.sql`SELECT l.* FROM pay_package_components l JOIN pay_packages p ON p.id=l.package_id AND p.company_id=${company}::uuid
   WHERE p.id=${source.sourceId}::uuid ORDER BY l.id LIMIT 1001 FOR SHARE OF l` as CompensationRow[];
 }else if(source.kind==='batch'){
  const rows=await ctx.sql`SELECT * FROM payroll_batches WHERE company_id=${company}::uuid AND id=${source.sourceId}::uuid FOR UPDATE` as CompensationRow[];
  sourceHeader=rows[0]??null;if(!sourceHeader)throw new Error('Owned payroll batch required');
  sourceLines=await ctx.sql`SELECT l.*,l.effective_from::text,l.effective_to::text FROM payroll_batch_lines l JOIN payroll_batches b ON b.id=l.batch_id AND b.company_id=${company}::uuid
   WHERE b.id=${source.sourceId}::uuid ORDER BY l.id LIMIT 1001 FOR SHARE OF l` as CompensationRow[];
 }
 if([employees,components,assignments,runs,versions].some(rows=>rows.length>10000)||sourceLines.length>1000)throw new Error('Compensation source population exceeds supported bound');
 return{company:companyRow,employees,components,assignments,runs,versions,sourceHeader,sourceLines};
}
export function assignmentState(row:CompensationRow,kind:PayrollCompensationAction['kind']):PayrollCompensationAction{
 return{kind,assignmentId:String(row.id),employeeId:String(row.employee_id),componentId:String(row.component_id),amount:String(row.amount),
  effectiveFrom:String(row.effective_from),effectiveTo:row.effective_to===null?null:String(row.effective_to),isRecurring:row.is_recurring===true};
}
