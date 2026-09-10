import {createHmac} from 'node:crypto';
import {canonicalJson} from './canonical';
import type {SnapshotSource,SnapshotRow} from './auditSnapshotCaptureQueries';
export const payrollSnapshotSources:SnapshotSource[]=[
{source:'payroll_run',family:'payroll',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (COALESCE(r.run_date,(make_date(r.period_year,r.period_month,1)+interval '1 month'-interval '1 day')::date) IS NULL OR COALESCE(r.run_date,(make_date(r.period_year,r.period_month,1)+interval '1 month'-interval '1 day')::date)<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (COALESCE(r.run_date,(make_date(r.period_year,r.period_month,1)+interval '1 month'-interval '1 day')::date) IS NULL OR COALESCE(r.run_date,(make_date(r.period_year,r.period_month,1)+interval '1 month'-interval '1 day')::date)<=${cutoff}::date))::int AS "excludedCount"
   FROM payroll_run_headers r  WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('currency',(SELECT c.default_currency FROM companies c WHERE c.id=${ctx.principal.companyId}::uuid),'period_month',r.period_month,'period_year',r.period_year,'status',r.status,'run_date',r.run_date::text,'total_gross',r.total_gross::text,'total_taxable',r.total_taxable::text,'total_paye',r.total_paye::text,'total_uif',r.total_uif::text,'total_sdl',r.total_sdl::text,'total_eti',r.total_eti::text,'total_net',r.total_net::text,'employee_count',r.employee_count,'created_at',r.created_at::text,'updated_at',r.updated_at::text)||CASE WHEN v.lineage_count>1 THEN jsonb_build_object('control_lineage_forked',true) ELSE '{}'::jsonb END AS data
   FROM payroll_run_headers r  LEFT JOIN LATERAL(SELECT cv.*,count(*) OVER() AS lineage_count FROM control_entity_versions cv WHERE cv.company_id=${ctx.principal.companyId}::uuid AND cv.entity_type='payroll_run' AND lower(cv.entity_id)=r.id::text ORDER BY cv.version DESC,(cv.entity_id=r.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (COALESCE(r.run_date,(make_date(r.period_year,r.period_month,1)+interval '1 month'-interval '1 day')::date) IS NULL OR COALESCE(r.run_date,(make_date(r.period_year,r.period_month,1)+interval '1 month'-interval '1 day')::date)<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'payroll_run_line',family:'payroll',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (COALESCE(p.run_date,(make_date(p.period_year,p.period_month,1)+interval '1 month'-interval '1 day')::date) IS NULL OR COALESCE(p.run_date,(make_date(p.period_year,p.period_month,1)+interval '1 month'-interval '1 day')::date)<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (COALESCE(p.run_date,(make_date(p.period_year,p.period_month,1)+interval '1 month'-interval '1 day')::date) IS NULL OR COALESCE(p.run_date,(make_date(p.period_year,p.period_month,1)+interval '1 month'-interval '1 day')::date)<=${cutoff}::date))::int AS "excludedCount"
   FROM payroll_run_lines r JOIN payroll_run_headers p ON p.id=r.run_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN payroll_employees e ON e.id=r.employee_id AND e.company_id=p.company_id WHERE p.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  const key=process.env.CONTROL_SNAPSHOT_SIGNING_KEY;
  if(!key||key.length<32)throw new Error('Independent snapshot signing key required');
  const rows=await ctx.sql`SELECT r.id::text,
   CASE WHEN octet_length(r.component_breakdown::text)<=65536 THEN r.component_breakdown END AS component_material,
   octet_length(r.component_breakdown::text) AS component_bytes,NULL::int AS version,jsonb_build_object('currency',(SELECT c.default_currency FROM companies c WHERE c.id=${ctx.principal.companyId}::uuid),'run_id',p.id,'employee_id',e.id,'employee_parent_unavailable',e.id IS NULL,'gross_pay',r.gross_pay::text,'taxable_income',r.taxable_income::text,'paye',r.paye::text,'uif_employee',r.uif_employee::text,'uif_employer',r.uif_employer::text,'sdl',r.sdl::text,'eti',r.eti::text,'net_pay',r.net_pay::text,'created_at',r.created_at::text) AS data
   FROM payroll_run_lines r JOIN payroll_run_headers p ON p.id=r.run_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN payroll_employees e ON e.id=r.employee_id AND e.company_id=p.company_id 
   WHERE p.company_id=${ctx.principal.companyId}::uuid AND (COALESCE(p.run_date,(make_date(p.period_year,p.period_month,1)+interval '1 month'-interval '1 day')::date) IS NULL OR COALESCE(p.run_date,(make_date(p.period_year,p.period_month,1)+interval '1 month'-interval '1 day')::date)<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as Array<SnapshotRow&{component_material:unknown;component_bytes:number}>;
  return rows.map(({component_material,component_bytes,...row})=>{
   if(component_bytes>65536)throw new Error('Snapshot payroll component resource limit');
   const fingerprint=createHmac('sha256',key).update(canonicalJson({domain:'isaflow:audit-snapshot:payroll-components:v1',
    companyId:ctx.principal.companyId,lineId:row.id,components:component_material})).digest('hex');
   return{...row,data:{...row.data,component_fingerprint:fingerprint}};
  });
 }
}
];
