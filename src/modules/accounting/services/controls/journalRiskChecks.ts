import type {ControlTx,ControlCheckResult} from './contracts';
import {analyseJournalRisks} from './journalRiskAnalysis';
import {loadJournalRiskPopulation} from './journalRiskQueries';
import {JOURNAL_RISK_COVERAGE,buildJournalRiskFinding,journalRiskMissingReasons} from './journalRiskShared';
import {riskHash,riskOptions,riskResult,type RiskCheckOptions} from './invoiceRiskQueriesResult';
import {JOURNAL_RISK_DEFAULT_LIMITS,type JournalRiskSourceLimits} from './journalRiskPopulationSql';
/**
 * `limits` is the plan v6 A14 seam: only the source page can be raised, only by a caller passing it (the differential
 * oracle); every transport passes two arguments and gets the defaults. It never enters `source`, so `sourceHash` and
 * every fingerprint are a function of the rows alone.
 */
export async function checkJournalRisks(ctx:ControlTx,options:RiskCheckOptions={},limits:JournalRiskSourceLimits=JOURNAL_RISK_DEFAULT_LIMITS):Promise<ControlCheckResult>{
 const parsed=riskOptions(options),source=await loadJournalRiskPopulation(ctx,parsed.cutoff,limits),missing:string[]=[];
 if(source.over)missing.push('async_scan_required:journal_population_exceeds_10000');
 if(source.missingPolicy)missing.push('unsupported_or_bounded_current_journal_policy');
 if(!source.thresholds.length)missing.push('no_supported_current_journal_threshold');
 for(const row of source.rows)missing.push(...journalRiskMissingReasons(row));
 const findings=analyseJournalRisks(source.rows,source.thresholds).map(buildJournalRiskFinding);
 return riskResult({companyId:ctx.principal.companyId,id:'journal_risk_checks',options,populationCount:source.populationCount,excludedCount:0,
  findings,missing,coverage:[...JOURNAL_RISK_COVERAGE],
  capturedAt:new Date().toISOString(),sourceHash:riskHash(source),sourceVersions:source.rows.filter(r=>r.version!==null)
   .map(row=>({entityType:'journal_entry',entityId:row.id,version:Number(row.version),fingerprint:riskHash(row)}))});
}
