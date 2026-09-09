import Decimal from 'decimal.js';
import {buildExactPayrollPlan} from './payrollExactPlan';
import {canonicalJson,canonicalMoney} from './canonical';
import {riskHash,type RiskFinding} from './invoiceRiskQueriesResult';
import type {PayrollControlPopulation,PayrollControlJournal} from './payrollControlTypes';
const D=Decimal.clone({precision:80});
const amount=(value:unknown)=>new D(canonicalMoney(String(value)));
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
function journalBuckets(lines:PayrollControlJournal['lines']){
 const buckets=new Map<string,{debit:Decimal;credit:Decimal}>();
 for(const line of lines){const entry=buckets.get(line.glAccountId)??{debit:new D(0),credit:new D(0)};
  entry.debit=entry.debit.add(amount(line.debit));entry.credit=entry.credit.add(amount(line.credit));buckets.set(line.glAccountId,entry);}
 return [...buckets].filter(([,v])=>!v.debit.isZero()||!v.credit.isZero()).sort(([a],[b])=>compare(a,b))
  .map(([id,value])=>({id,debit:value.debit.toFixed(),credit:value.credit.toFixed()}));
}
/** Detective comparisons reuse the same exact ledger plan as the controlled writer. */
export function analysePayrollControls(source:PayrollControlPopulation){
 const findings:RiskFinding[]=[],missing:string[]=['independent_employee_settlement_evidence_unavailable','paye_sdl_remittance_associations_unavailable','historical_salary_component_coverage_unavailable'];
 const add=(kind:string,id:string,value:string,message:string,classification:'candidate'|'confirmed'='candidate',employeeIds:string[]=[])=>findings.push({
  amount:value,currency:source.currency??'',finding:{key:riskHash({kind,id}),kind,severity:classification==='confirmed'?'high':'medium',classification,
   entities:[{entityType:kind==='payroll_beneficiary_reuse'?'employee':'payroll_run',entityId:id.split(':')[0]!},...employeeIds.filter(e=>e!==id).map(entityId=>({entityType:'employee',entityId}))],message,evidence:[]}});
 if(source.over){missing.push('async_scan_required:payroll_population_exceeds_10000');return{findings,missing};}
 if(source.currency!=='ZAR')missing.push('payroll_currency_unsupported_or_missing');
 if(!source.runs.length)missing.push('payroll_run_population_unavailable');
 for(const run of source.runs){
  if(run.header.status==='draft'&&!run.lines.length&&!run.journal){missing.push('uncalculated_payroll_run');continue;}
  if(run.version===null)missing.push('historical_payroll_versions_unavailable');
  let plan:ReturnType<typeof buildExactPayrollPlan>|null=null;
  try{
   const taxable=run.lines.reduce((sum,line)=>sum.add(amount(line.taxable_income)),new D(0));
   if(!taxable.eq(amount(run.header.total_taxable)))throw new Error('Payroll taxable total mismatch');
   plan=buildExactPayrollPlan(run.header,run.lines,source.accounts,source.employees,source.allocations,source.mappings);
  }catch(error){
   if(!(error instanceof Error))throw error;
   if(/totals|population|UIF|taxable/i.test(error.message))add('payroll_totals_mismatch',run.id,String(run.header.total_gross),'Recorded payroll totals or employee population do not reconcile.','confirmed');
   else missing.push('payroll_expected_ledger_material_unavailable');
  }
  if(!run.journal)missing.push('payroll_journal_evidence_unavailable');
  else if(run.journal.status!=='posted'||run.journal.reversed||run.journal.source!=='auto_payroll'||run.journal.sourceRecordId!==run.id){
   if(['approved','paid'].includes(String(run.header.status)))add('payroll_journal_state_mismatch',run.id,String(run.header.total_net),'Approved payroll lacks an eligible owned unreversed payroll posting.','confirmed');
   else missing.push('payroll_unposted_or_reopened');
  }else if(plan&&canonicalJson(journalBuckets(plan.lines))!==canonicalJson(journalBuckets(run.journal.lines)))
   add('payroll_journal_mismatch',run.id,String(run.header.total_gross),'Posted ledger account directions and exact totals differ from the shared payroll plan.','confirmed');
  const periodStart=`${run.header.period_year}-${String(run.header.period_month).padStart(2,'0')}-01`;
  for(const line of run.lines){
   const employeeId=String(line.employee_id),employee=source.employees.find(e=>e.id===employeeId);
   if(!employee){missing.push('payroll_employee_ownership_unavailable');continue;}
   const cost=amount(line.gross_pay).add(amount(line.uif_employer)).add(amount(line.sdl)).sub(amount(line.eti));
   if(cost.isZero())add('payroll_zero_cost',`${run.id}:${employeeId}`,'0','Employee has zero recorded employer cost; investigate employment and payroll inputs.','candidate',[employeeId]);
   if(employee.end_date&&String(employee.end_date)<periodStart&&(cost.gt(0)||amount(line.net_pay).gt(0)))
    add('payroll_after_termination',`${run.id}:${employeeId}`,String(line.net_pay),'Payroll occurs after the recorded employment end period; final adjustments may be legitimate. Settlement is not established.','candidate',[employeeId]);
  }
 }
 for(const group of source.beneficiaryGroups){const ids=[...new Set(group)].sort(compare);if(ids.length>1)
  add('payroll_beneficiary_reuse',ids[0]!,'0','Multiple employees share current bank details. Shared accounts may be legitimate.','candidate',ids);}
 for(const change of source.componentChanges)add('payroll_component_change',`${change.runId}:${change.eventId}`,'0','Recorded salary component change requires review; a legitimate salary adjustment is possible.','candidate',[change.employeeId]);
 for(const declaration of source.declarations){
  const runs=source.runs.filter(run=>Number(run.header.period_year)===declaration.year&&Number(run.header.period_month)===declaration.month);
  if(!runs.length){missing.push('uif_declaration_payroll_source_unavailable');continue;}
  const expected=runs.flatMap(run=>run.lines).reduce((sum,line)=>sum.add(amount(line.uif_employee)).add(amount(line.uif_employer)),new D(0));
  const declared=amount(declaration.employee).add(amount(declaration.employer));
  if(!expected.eq(declared))add('payroll_uif_declaration_mismatch',runs[0]!.id,declared.toFixed(),'UIF declaration contributions differ from complete payroll lines.','confirmed');
  if(declaration.status==='paid'){
   const journal=declaration.journal;
   if(!journal)missing.push('uif_settlement_journal_unavailable');
   else{
    const uif=source.accounts.filter(row=>row.account_code==='2150');
    const bank=source.accounts.filter(row=>row.account_code==='1110');
    if(uif.length!==1||bank.length!==1)missing.push('uif_settlement_account_mapping_unavailable');
    else if(journal.status!=='posted'||journal.reversed||canonicalJson(journalBuckets(journal.lines))!==canonicalJson(journalBuckets([
     {glAccountId:String(uif[0]!.id),debit:declared.toFixed(),credit:'0'},{glAccountId:String(bank[0]!.id),debit:'0',credit:declared.toFixed()}])))
     add('payroll_uif_settlement_mismatch',runs[0]!.id,declared.toFixed(),'Recorded UIF settlement journal does not match its declaration.','confirmed');
   }
  }else missing.push('uif_settlement_not_recorded');
 }
 if(!source.declarations.length)missing.push('uif_declaration_evidence_unavailable');
 return{findings,missing:[...new Set(missing)].sort(compare)};
}
