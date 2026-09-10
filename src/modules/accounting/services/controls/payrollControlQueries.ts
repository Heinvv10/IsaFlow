import {assertControlTx} from './context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx} from './contracts';
import type {PayrollControlPopulation} from './payrollControlTypes';
/** All populations below share one SQL statement snapshot; sensitive employee fields never leave SQL. */
export async function loadPayrollControlPopulation(ctx:ControlTx,cutoff:string|null):Promise<PayrollControlPopulation>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:reports');await assertEffectivePermission(ctx,'read:payroll');
 const company=ctx.principal.companyId;
 const rows=await ctx.sql`WITH owned_runs AS MATERIALIZED(
  SELECT h.*,COALESCE(h.run_date,(make_date(h.period_year,h.period_month,1)+interval '1 month - 1 day')::date) AS accounting_date
  FROM payroll_run_headers h WHERE h.company_id=${company}::uuid
   AND COALESCE(h.run_date,(make_date(h.period_year,h.period_month,1)+interval '1 month - 1 day')::date)<=COALESCE(${cutoff}::date,'infinity'::date)
 ), runs AS(SELECT * FROM owned_runs ORDER BY id LIMIT 10000),
 owned_lines AS MATERIALIZED(SELECT l.* FROM payroll_run_lines l JOIN owned_runs h ON h.id=l.run_id),
 lines AS(SELECT * FROM owned_lines ORDER BY run_id,id LIMIT 10000),
 employees AS(SELECT id,status,start_date::text,end_date::text,cost_centre_id FROM payroll_employees WHERE company_id=${company}::uuid ORDER BY id LIMIT 10000),
 accounts AS(SELECT id,account_code,account_type,account_subtype,is_active FROM gl_accounts WHERE company_id=${company}::uuid ORDER BY id LIMIT 10000),
 allocations AS(SELECT employee_id,cost_centre_id,percentage::text FROM payroll_employee_cost_allocations WHERE company_id=${company}::uuid ORDER BY id LIMIT 10000),
 mappings AS(SELECT m.cost_centre_id,m.expense_account_id FROM cost_centre_gl_mappings m
  JOIN cost_centres c ON c.company_id=m.company_id AND c.id=m.cost_centre_id
  JOIN gl_accounts a ON a.company_id=m.company_id AND a.id=m.expense_account_id WHERE m.company_id=${company}::uuid ORDER BY m.id LIMIT 10000),
 declarations AS(SELECT d.* FROM uif_declarations d WHERE d.company_id=${company}::uuid
  AND (make_date(d.period_year,d.period_month,1)+interval '1 month - 1 day')::date<=COALESCE(${cutoff}::date,'infinity'::date) ORDER BY d.id LIMIT 10000),
 journal_ids AS(SELECT journal_entry_id AS id FROM runs UNION SELECT journal_entry_id FROM declarations),
 journals AS(SELECT j.id,j.status,j.source,j.source_record_id::text AS "sourceRecordId",(j.reversed_at IS NOT NULL) AS reversed,
  (SELECT count(*) FROM gl_journal_lines raw WHERE raw.company_id=j.company_id AND raw.journal_entry_id=j.id) AS "lineCount",
  EXISTS(SELECT 1 FROM gl_journal_lines raw LEFT JOIN gl_accounts a ON a.company_id=raw.company_id AND a.id=raw.gl_account_id
   WHERE raw.company_id=j.company_id AND raw.journal_entry_id=j.id AND a.id IS NULL) AS "accountOwnershipMissing",
  COALESCE((SELECT jsonb_agg(x ORDER BY x.id) FROM(SELECT l.id,l.gl_account_id AS "glAccountId",l.debit::text,l.credit::text FROM gl_journal_lines l
   JOIN gl_accounts a ON a.company_id=l.company_id AND a.id=l.gl_account_id
   WHERE l.company_id=j.company_id AND l.journal_entry_id=j.id ORDER BY l.id LIMIT 10001)x),'[]'::jsonb) AS lines
  FROM gl_journal_entries j JOIN journal_ids i ON i.id=j.id WHERE j.company_id=${company}::uuid),
 shared_banks AS(SELECT array_agg(DISTINCT e.id::text ORDER BY e.id::text) AS ids FROM payroll_bank_details b
  JOIN payroll_employees e ON e.id=b.employee_id AND e.company_id=${company}::uuid
  WHERE b.is_active AND b.effective_from<=COALESCE(${cutoff}::date,CURRENT_DATE)
  AND trim(b.account_number)<>'' AND trim(b.branch_code)<>''
  GROUP BY trim(b.account_number),trim(b.branch_code) HAVING count(DISTINCT e.id)>1 ORDER BY min(e.id::text) LIMIT 10001),
 component_material AS(SELECT l.employee_id,l.run_id,h.period_year,h.period_month,
  CASE WHEN jsonb_typeof(l.component_breakdown::jsonb)='array' THEN
   (SELECT jsonb_agg(jsonb_build_object('id',c->>'componentId','amount',c->>'amount') ORDER BY c->>'componentId') FROM jsonb_array_elements(l.component_breakdown::jsonb)c)
   ELSE NULL END AS components
  FROM lines l JOIN runs h ON h.id=l.run_id JOIN employees e ON e.id=l.employee_id),
 compared AS(SELECT *,lag(components) OVER(PARTITION BY employee_id ORDER BY period_year,period_month,run_id) AS previous,
  lag(run_id) OVER(PARTITION BY employee_id ORDER BY period_year,period_month,run_id) AS prior_run FROM component_material),
 changes AS(SELECT employee_id::text AS "employeeId",prior_run::text AS "eventId",run_id::text AS "runId" FROM compared
  WHERE previous IS NOT NULL AND components IS NOT NULL AND components<>previous ORDER BY run_id,employee_id LIMIT 10001)
 SELECT jsonb_build_object(
  'currency',(SELECT default_currency FROM companies WHERE id=${company}::uuid),
  'sourceTotals',jsonb_build_object(
   'headerGross',(SELECT COALESCE(sum(total_gross),0)::text FROM owned_runs),'lineGross',(SELECT COALESCE(sum(gross_pay),0)::text FROM owned_lines),
   'headerNet',(SELECT COALESCE(sum(total_net),0)::text FROM owned_runs),'lineNet',(SELECT COALESCE(sum(net_pay),0)::text FROM owned_lines),
   'headerPaye',(SELECT COALESCE(sum(total_paye),0)::text FROM owned_runs),'linePaye',(SELECT COALESCE(sum(paye),0)::text FROM owned_lines),
   'headerUif',(SELECT COALESCE(sum(total_uif),0)::text FROM owned_runs),'lineUif',(SELECT COALESCE(sum(uif_employee+uif_employer),0)::text FROM owned_lines),
   'headerSdl',(SELECT COALESCE(sum(total_sdl),0)::text FROM owned_runs),'lineSdl',(SELECT COALESCE(sum(sdl),0)::text FROM owned_lines)),
  'populationCount',(SELECT count(*) FROM owned_runs),'lineCount',(SELECT count(*) FROM owned_lines),
  'employeeCount',(SELECT count(*) FROM payroll_employees WHERE company_id=${company}::uuid),
  'over',((SELECT count(*) FROM owned_runs)>10000 OR (SELECT count(*) FROM owned_lines)>10000
   OR (SELECT count(*) FROM payroll_employees WHERE company_id=${company}::uuid)>10000
   OR (SELECT count(*) FROM gl_accounts WHERE company_id=${company}::uuid)>10000
   OR (SELECT count(*) FROM payroll_employee_cost_allocations WHERE company_id=${company}::uuid)>10000
   OR (SELECT count(*) FROM cost_centre_gl_mappings WHERE company_id=${company}::uuid)>10000
   OR (SELECT count(*) FROM uif_declarations WHERE company_id=${company}::uuid)>10000
   OR (SELECT count(*) FROM shared_banks)>10000 OR (SELECT count(*) FROM changes)>10000
   OR EXISTS(SELECT 1 FROM journals WHERE "lineCount">10000 OR jsonb_array_length(lines)>10000)),
  'employees',COALESCE((SELECT jsonb_agg(e ORDER BY e.id) FROM employees e),'[]'::jsonb),
  'accounts',COALESCE((SELECT jsonb_agg(a ORDER BY a.id) FROM accounts a),'[]'::jsonb),
  'allocations',COALESCE((SELECT jsonb_agg(a ORDER BY a.employee_id,a.cost_centre_id) FROM allocations a),'[]'::jsonb),
  'mappings',COALESCE((SELECT jsonb_agg(m ORDER BY m.cost_centre_id) FROM mappings m),'[]'::jsonb),
  'beneficiaryGroups',COALESCE((SELECT jsonb_agg(ids ORDER BY ids) FROM shared_banks),'[]'::jsonb),
  'componentChanges',COALESCE((SELECT jsonb_agg(c ORDER BY c."runId",c."employeeId") FROM changes c),'[]'::jsonb),
  'runs',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'date',h.accounting_date::text,'version',v.version,
   'header',jsonb_build_object('employee_count',h.employee_count,'period_year',h.period_year,'period_month',h.period_month,'status',h.status,
    'total_gross',h.total_gross::text,'total_taxable',h.total_taxable::text,'total_paye',h.total_paye::text,'total_uif',h.total_uif::text,
    'total_sdl',h.total_sdl::text,'total_eti',h.total_eti::text,'total_net',h.total_net::text),
   'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'employee_id',l.employee_id,'gross_pay',l.gross_pay::text,
    'taxable_income',l.taxable_income::text,'paye',l.paye::text,'uif_employee',l.uif_employee::text,'uif_employer',l.uif_employer::text,
    'sdl',l.sdl::text,'eti',l.eti::text,'net_pay',l.net_pay::text) ORDER BY l.id) FROM lines l WHERE l.run_id=h.id),'[]'::jsonb),
   'journal',(SELECT to_jsonb(j) FROM journals j WHERE j.id=h.journal_entry_id)) ORDER BY h.id) FROM runs h
   LEFT JOIN LATERAL(SELECT cv.* FROM control_entity_versions cv WHERE cv.company_id=h.company_id AND cv.entity_type='payroll_run' AND lower(cv.entity_id)=h.id::text ORDER BY cv.version DESC,(cv.entity_id=h.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true),'[]'::jsonb),
  'declarations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',d.id,'year',d.period_year,'month',d.period_month,
   'employee',d.total_employee_contribution::text,'employer',d.total_employer_contribution::text,'status',d.status,
   'journal',(SELECT to_jsonb(j) FROM journals j WHERE j.id=d.journal_entry_id)) ORDER BY d.id) FROM declarations d),'[]'::jsonb)
 ) AS population` as {population:PayrollControlPopulation}[];
 if(!rows[0])throw new Error('Payroll population query returned no snapshot');return rows[0].population;
}
