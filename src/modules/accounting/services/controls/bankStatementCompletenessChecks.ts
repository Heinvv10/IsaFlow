import type {ControlTx,ControlCheckResult} from './contracts';
import {loadBankStatementCompleteness} from './bankStatementCompletenessQueries';
import {analyseBankStatementCompleteness} from './bankStatementCompletenessAnalysis';
import {riskHash,riskOptions,riskResult,type RiskCheckOptions,type RiskFinding} from './invoiceRiskQueriesResult';
export async function checkBankStatementCompleteness(ctx:ControlTx,options:RiskCheckOptions={}):Promise<ControlCheckResult>{
 const parsed=riskOptions(options),source=await loadBankStatementCompleteness(ctx,parsed.cutoff),missing:string[]=[],findings:RiskFinding[]=[];
 if(source.over)missing.push('async_scan_required:statement_population_exceeds_10000');
 if(!source.rows.length)missing.push('source_statement_population_unavailable');
 for(const row of source.rows){
  const result=analyseBankStatementCompleteness(row);missing.push(...result.missing);
  missing.push('source_statement_currency_unverified');
  if(row.importedCount>10000)missing.push('async_scan_required:imported_statement_material_exceeds_10000');
  if(row.version===null)missing.push('historical_statement_versions_unavailable');
  if(row.sourceStatus==='rolled_back')missing.push('source_statement_import_rolled_back');
  if(!result.reasons.length)continue;
  findings.push({amount:result.amount,currency:row.currency,finding:{key:riskHash({id:row.id,kind:'statement_comparison'}),
   kind:'source_statement_discrepancy',severity:'high',classification:result.classification,
   entities:[{entityType:'bank_statement_import',entityId:row.id},...(row.accountId?[{entityType:'gl_account',entityId:row.accountId}]:[])],
   message:`${result.reasons.join('; ')}. Source count ${row.sourceCount}, imported count ${row.importedCount}; extraction requires independent review.`,
   evidence:row.sourceBytesVerified&&row.documentId?[{store:'captured',entityType:'bank_statement_import',entityId:row.id,evidenceId:row.documentId,version:null,hash:row.documentHash}]:[]}});
 }
 return riskResult({companyId:ctx.principal.companyId,id:'bank_statement_completeness',options,populationCount:source.populationCount,excludedCount:0,
  findings,missing,coverage:['owned_bank_accounts_and_source_imports','source_period_imported_count_and_signed_movement','verified_current_source_bytes','no_empty_day_gap_inference','no_external_confirmation_claim','comparison_deltas_in_company_ledger_currency_not_deduplicated_cash_exposure'],
  capturedAt:new Date().toISOString(),sourceHash:riskHash(source),sourceVersions:source.rows.filter(r=>r.version!==null)
   .map(row=>({entityType:'bank_statement_import',entityId:row.id,version:Number(row.version),fingerprint:riskHash(row)}))});
}
