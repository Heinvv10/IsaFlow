import {riskHash,type RiskFinding} from './invoiceRiskQueriesResult';
import type {JournalRiskRow} from './journalRiskAnalysis';
/** Both the synchronous detector and the check-run adapter read the population through this shape. */
export interface JournalRiskSourceRow extends JournalRiskRow {
 lineCount:number;changeCount:number;reversalOwned:boolean;periodEventVersion:number|null;
}
/** The one statement of what a journal population fails to cover. A private copy in either path is a second truth. */
export const JOURNAL_RISK_COVERAGE:readonly string[]=Object.freeze(['owned_posted_journals','actual_time_africa_johannesburg',
 'accounting_cutoff_current_observation','current_threshold_investigation_context','recorded_period_event_chronology']);
/** Per-row missing reasons, in the order the synchronous detector has always emitted them. */
export function journalRiskMissingReasons(row:JournalRiskSourceRow):string[]{
 const missing:string[]=[];
 if(row.version===null)missing.push('historical_journal_versions_unavailable');
 if(row.actualBasis!=='posted_at')missing.push('actual_posting_time_unavailable_creation_time_used');
 if(!row.periodEventId)missing.push('historical_period_state_unavailable');
 if(row.changeCount>100)missing.push('journal_change_history_exceeds_100');
 if(row.lineCount>100)missing.push('journal_line_material_exceeds_100');
 if(!row.reversalOwned)missing.push('reversal_parent_ownership_unavailable');
 return missing;
}
/** The finding literal. Statistical/chronological context is a lead, never a fraud or policy-violation conclusion. */
export function buildJournalRiskFinding(input:{row:JournalRiskSourceRow;reasons:readonly string[];classification:'candidate'|'confirmed'}):RiskFinding{
 const {row,reasons,classification}=input;
 return{amount:row.amount,currency:row.currency,
  finding:{key:riskHash({journal:row.id,check:'journal_risk'}),kind:'journal_investigation_lead',severity:'medium',classification,
   entities:[{entityType:'journal_entry',entityId:row.id},...(row.reversalOfId&&row.reversalOwned?[{entityType:'journal_entry',entityId:row.reversalOfId}]:[])],
   message:`${reasons.join('; ')}. Actual-time basis ${row.actualBasis}; current policy context only. An accrual or correction may be legitimate.`,evidence:[]}};
}
