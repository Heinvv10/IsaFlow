import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {loadInvoiceRiskImports} from './invoiceRiskQueriesImports';
import {assertControlTx} from './context';
import {canonicalMoney} from './canonical';
import type {ControlTx,ControlCheckResult} from './contracts';
import {loadInvoiceRiskPopulation,type InvoiceRiskRow} from './invoiceRiskQueries';
import {riskOptions,riskHash,riskResult,RISK_SOURCE_LIMIT,type RiskCheckOptions,type RiskFinding} from './invoiceRiskQueriesResult';
export function detectInvoiceDuplicates(rows:readonly InvoiceRiskRow[]):RiskFinding[]{
 const groups=new Map<string,InvoiceRiskRow[]>(),findings:RiskFinding[]=[];
 for(const row of rows){
  if(row.supplier_owned===false||['cancelled','rejected','void','voided'].includes(row.status))continue;
  const key=riskHash({supplier:row.supplier_id,date:row.invoice_date,currency:row.currency,net:canonicalMoney(row.subtotal),tax:canonicalMoney(row.tax_amount),gross:canonicalMoney(row.total_amount)});
  const group=groups.get(key)??[];group.push(row);groups.set(key,group);
 }
 for(const group of groups.values()){
  group.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const verified=new Map<string,InvoiceRiskRow>();
  if(group[0]?.file_verified&&group[0].file_hash)verified.set(group[0].file_hash,group[0]);
  for(let i=1;i<group.length;i++){
   const row=group[i]!,sameSource=row.file_verified&&row.file_hash?verified.get(row.file_hash):undefined;
   const prior=sameSource??group[0]!,confirmed=!!sameSource;
   if(row.file_verified&&row.file_hash&&!verified.has(row.file_hash))verified.set(row.file_hash,row);
   findings.push({amount:canonicalMoney(row.total_amount),currency:row.currency,finding:{key:riskHash({check:'duplicate_invoice',ids:[prior.id,row.id]}),kind:confirmed?'reused_invoice_source':'similar_invoice',
    severity:confirmed?'high':'medium',classification:confirmed?'confirmed':'candidate',entities:[{entityType:'supplier_invoice',entityId:prior.id},{entityType:'supplier_invoice',entityId:row.id}],
    message:confirmed?'Identical verified source bytes and supplier/date/amounts were reused; investigate whether these represent the same obligation.':'Same supplier, date and exact net/tax/gross amounts; distinct legitimate obligations remain possible, including changed references.',
    evidence:[prior,row].filter(r=>r.document_id&&r.file_hash).map(r=>({store:'captured' as const,evidenceId:r.document_id!,entityType:'supplier_invoice',entityId:r.id,version:null,hash:r.file_hash}))}});
  }
 }
 return findings;
}
export async function checkDuplicateInvoices(ctx:ControlTx,options:RiskCheckOptions={}):Promise<ControlCheckResult>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:invoices');await assertEffectivePermission(ctx,'read:reports');
 const parsed=riskOptions(options),population=await loadInvoiceRiskPopulation(ctx,parsed.cutoff),missing:string[]=[...population.evidenceMissing];
 const imports=await loadInvoiceRiskImports(ctx,parsed.cutoff),populationCount=population.populationCount+imports.populationCount;
 const over=populationCount>RISK_SOURCE_LIMIT,rows=over?[]:population.rows;
 if(imports.populationCount>imports.mappedCount)missing.push('unmapped_import_invoice_financial_material_unavailable');
 if(imports.rows.some(row=>row.invoice_date===null))missing.push('import_invoice_accounting_date_unavailable');
 if(over)missing.push('async_scan_required:invoice_population_exceeds_10000');
 if(rows.some(row=>row.supplier_owned!==false&&!row.file_verified))missing.push('verified_source_file_bytes_unavailable');
 if(rows.some(row=>row.version===null))missing.push('historical_entity_versions_unavailable');
 if(rows.some(row=>row.supplier_owned===false))missing.push('owned_supplier_parent_unavailable');
 const excluded=rows.filter(row=>row.supplier_owned===false||['cancelled','rejected','void','voided'].includes(row.status)).length;
 return riskResult({companyId:ctx.principal.companyId,id:'duplicate_invoice_checks',options,populationCount,excludedCount:excluded+imports.mappedCount,findings:detectInvoiceDuplicates(rows),missing,
  coverage:['owned_native_supplier_invoices','owned_sage_staging_population','owned_native_import_mirrors_excluded','exact_supplier_date_net_tax_gross','captured_source_byte_reuse','current_values_at_accounting_cutoff','synchronous_population_limit_10000','amount_totals_count_each_flagged_additional_invoice_once'],
  capturedAt:population.capturedAt,sourceHash:riskHash({rows,imports:imports.rows,populationCount}),sourceVersions:rows.filter(r=>r.version!==null).map(r=>({entityType:'supplier_invoice',entityId:r.id,version:Number(r.version),fingerprint:riskHash(r)}))});
}
