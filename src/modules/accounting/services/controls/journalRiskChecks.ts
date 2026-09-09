import type {ControlTx,ControlCheckResult} from './contracts';
import {analyseJournalRisks} from './journalRiskAnalysis';
import {loadJournalRiskPopulation} from './journalRiskQueries';
import {riskHash,riskOptions,riskResult,type RiskCheckOptions} from './invoiceRiskQueriesResult';
export async function checkJournalRisks(ctx:ControlTx,options:RiskCheckOptions={}):Promise<ControlCheckResult>{
 const parsed=riskOptions(options),source=await loadJournalRiskPopulation(ctx,parsed.cutoff),missing:string[]=[];
 if(source.over)missing.push('async_scan_required:journal_population_exceeds_10000');
 if(source.missingPolicy)missing.push('unsupported_or_bounded_current_journal_policy');
 if(!source.thresholds.length)missing.push('no_supported_current_journal_threshold');
 for(const row of source.rows){
  if(row.version===null)missing.push('historical_journal_versions_unavailable');
  if(row.actualBasis!=='posted_at')missing.push('actual_posting_time_unavailable_creation_time_used');
  if(!row.periodEventId)missing.push('historical_period_state_unavailable');
  if(row.changeCount>100)missing.push('journal_change_history_exceeds_100');
  if(row.lineCount>100)missing.push('journal_line_material_exceeds_100');
  if(!row.reversalOwned)missing.push('reversal_parent_ownership_unavailable');
 }
 const findings=analyseJournalRisks(source.rows,source.thresholds).map(({row,reasons,classification})=>({amount:row.amount,currency:row.currency,
  finding:{key:riskHash({journal:row.id,check:'journal_risk'}),kind:'journal_investigation_lead',severity:'medium' as const,classification,
   entities:[{entityType:'journal_entry',entityId:row.id},...(row.reversalOfId&&row.reversalOwned?[{entityType:'journal_entry',entityId:row.reversalOfId}]:[])],
   message:`${reasons.join('; ')}. Actual-time basis ${row.actualBasis}; current policy context only. An accrual or correction may be legitimate.`,evidence:[]}}));
 return riskResult({companyId:ctx.principal.companyId,id:'journal_risk_checks',options,populationCount:source.populationCount,excludedCount:0,
  findings,missing,coverage:['owned_posted_journals','actual_time_africa_johannesburg','accounting_cutoff_current_observation','current_threshold_investigation_context','recorded_period_event_chronology'],
  capturedAt:new Date().toISOString(),sourceHash:riskHash(source),sourceVersions:source.rows.filter(r=>r.version!==null)
   .map(row=>({entityType:'journal_entry',entityId:row.id,version:Number(row.version),fingerprint:riskHash(row)}))});
}
