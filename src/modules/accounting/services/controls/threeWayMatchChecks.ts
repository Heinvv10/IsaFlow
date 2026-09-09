import {assertControlTx} from './context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {ControlTx,ControlCheckResult} from './contracts';
import {queryThreeWayMatch} from '../ap/threeWayMatchQueryService';
import {riskHash,riskOptions,riskResult,type RiskCheckOptions,type RiskFinding} from './invoiceRiskQueriesResult';
export async function checkThreeWayMatchExceptions(ctx:ControlTx,options:RiskCheckOptions={}):Promise<ControlCheckResult>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:reports');
 const parsed=riskOptions(options),population=await queryThreeWayMatch(ctx,parsed.cutoff?{cutoff:parsed.cutoff}:{}),findings:RiskFinding[]=[],missing:string[]=[];
 if(population.over)missing.push('async_scan_required:three_way_source_population_exceeds_10000');
 for(const result of population.results){
  if(result.excluded)continue;missing.push(...result.missing);
  if(result.row.version===null)missing.push('historical_match_source_versions_unavailable');
  if(result.match?.mismatches.length){
   findings.push({amount:result.row.line_total??'0',currency:result.row.currency,finding:{key:riskHash({kind:'three_way_mismatch',invoice:result.row.invoice_id,line:result.row.item_id}),
    kind:'three_way_mismatch',severity:'high',classification:'confirmed',entities:[{entityType:'supplier_invoice',entityId:result.row.invoice_id}],
    message:`${result.match.mismatches.join('; ')}. Quantity tolerance ${result.tolerance.qty}%, price tolerance ${result.tolerance.price}% (${result.tolerance.source}); persisted match state ${result.row.cached_status}.`,evidence:[]}});
  }
 }
 const versions=new Map(population.results.filter(r=>r.row.version!==null).map(r=>[r.row.invoice_id,r.row.version]));
 return riskResult({companyId:ctx.principal.companyId,id:'three_way_match_exceptions',options,populationCount:population.populationCount,
  excludedCount:population.results.filter(r=>r.excluded).length,findings,missing,
  coverage:['owned_po_linked_invoice_lines','flat_purchase_order_accepted_receipts','separate_supplier_purchase_order_family','cumulative_partial_invoices','current_tolerance_rows_bound','current_values_at_accounting_cutoff'],
  capturedAt:new Date().toISOString(),sourceHash:population.fingerprint,sourceVersions:[...versions].map(([id,version])=>({entityType:'supplier_invoice',entityId:id,version:Number(version),fingerprint:riskHash(population.results.filter(r=>r.row.invoice_id===id).map(r=>r.row))}))});
}
