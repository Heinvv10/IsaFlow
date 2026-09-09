import type {ControlTx,ControlCheckResult} from './contracts';
import {canonicalJson} from './canonical';
import {riskHash,riskOptions,riskResult,type RiskCheckOptions} from './invoiceRiskQueriesResult';
import {loadPayrollControlPopulation} from './payrollControlQueries';
import {analysePayrollControls} from './payrollControlAnalysis';
export async function checkPayrollControls(ctx:ControlTx,options:RiskCheckOptions={}):Promise<ControlCheckResult>{
 const captured=JSON.parse(canonicalJson(options)) as RiskCheckOptions,parsed=riskOptions(captured);
 const source=await loadPayrollControlPopulation(ctx,parsed.cutoff),analysis=analysePayrollControls(source);
 return riskResult({companyId:ctx.principal.companyId,id:'payroll_control_checks',options:captured,populationCount:source.populationCount,
  excludedCount:Math.max(0,source.populationCount-source.runs.length),findings:analysis.findings,missing:analysis.missing,
  coverage:[...Object.keys(source.sourceTotals).sort().map(key=>`source_total:${key}:${source.sourceTotals[key]}`),'owned_payroll_runs','complete_header_line_totals_before_pagination',`source_line_count:${source.lineCount}`,`source_employee_count:${source.employeeCount}`,
   'shared_exact_payroll_ledger_plan','current_owned_beneficiary_reuse_candidates','recorded_period_component_comparison','owned_uif_declaration_journal_reconciliation'],
  capturedAt:new Date().toISOString(),sourceHash:riskHash(source),sourceVersions:source.runs.filter(run=>run.version!==null)
   .map(run=>({entityType:'payroll_run',entityId:run.id,version:run.version!,fingerprint:riskHash(run)}))});
}
