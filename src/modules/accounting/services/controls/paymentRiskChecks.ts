import Decimal from 'decimal.js';
import {assertEffectivePermission,EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import {canonicalMoney} from './canonical';
import {beneficiaryFingerprint} from './changeProtection';
import type {ControlTx,ControlCheckResult,EntityVersionRef} from './contracts';
import {loadPaymentRiskPopulation,type PaymentRiskRow} from './invoiceRiskQueriesPayments';
import {loadRiskBeneficiaries} from './invoiceRiskQueriesBeneficiaries';
import {detectSharedRiskBeneficiaries} from './paymentRiskChecksBeneficiaries';
import {riskOptions,riskHash,riskResult,RISK_SOURCE_LIMIT,type RiskCheckOptions,type RiskFinding} from './invoiceRiskQueriesResult';
const D=Decimal.clone({precision:80});
export function paymentRiskCurrency(row:PaymentRiskRow):string|null{
 if(!row.allocations.length||row.allocations.some(a=>!a.currency||!/^[A-Z]{3}$/.test(a.currency))||new Set(row.allocations.map(a=>a.currency)).size!==1)return null;
 if(!row.allocations.reduce((n,a)=>n.add(canonicalMoney(a.amount)),new D(0)).eq(canonicalMoney(row.total_amount)))return null;
 return row.allocations[0]!.currency;
}
export function detectPaymentPatterns(rows:readonly PaymentRiskRow[]):RiskFinding[]{
 const findings:RiskFinding[]=[],groups=new Map<string,PaymentRiskRow[]>();
 for(const row of rows){
  if(!['approved','processed','reconciled'].includes(row.status)||!paymentRiskCurrency(row))continue;
  const currency=paymentRiskCurrency(row)!,amount=canonicalMoney(row.total_amount);
  const signature=riskHash({supplier:row.supplier_id,amount,currency,allocations:[...row.allocations].sort((a,b)=>a.invoice_id<b.invoice_id?-1:1)});
  const group=groups.get(signature)??[];group.push(row);groups.set(signature,group);
  const preparations=new Map<string,Set<string>>();
  for(const attempt of row.attempts){const intents=preparations.get(attempt.preparation_id)??new Set<string>();intents.add(attempt.intent_id);preparations.set(attempt.preparation_id,intents);}
  for(const [preparation,intents] of preparations)if(intents.size>1)findings.push({amount:new D(amount).mul(intents.size-1).toFixed(),currency,finding:{
   key:riskHash({kind:'repeated_prepared_release',payment:row.id,preparation}),kind:'repeated_prepared_release',severity:'high',classification:'confirmed',
   entities:[{entityType:'supplier_payment',entityId:row.id},...[...intents].sort().map(entityId=>({entityType:'payment_release_intent',entityId}))],
   message:'The same immutable payment preparation has more than one attempted release intent; external settlement confirmation remains required.',evidence:[]}});
  const attempts=row.attempts.length?row.attempts:row.processed_at?[{intent_id:null,attempted_at:row.processed_at,verified_at:row.legacy_verified_at}]:[];
  for(const attempt of attempts){
   if(!attempt.verified_at)continue;
   const elapsed=Date.parse(attempt.attempted_at)-Date.parse(attempt.verified_at);
   if(elapsed<0||elapsed>48*60*60*1000||!Number.isFinite(elapsed))continue;
   findings.push({amount,currency,finding:{key:riskHash({kind:'recent_beneficiary_change',payment:row.id,intent:attempt.intent_id}),kind:'recent_beneficiary_change',
    severity:'high',classification:'confirmed',entities:[{entityType:'supplier_payment',entityId:row.id},{entityType:'supplier',entityId:row.supplier_id}],
    message:'Payment activity followed an independently verified beneficiary change within 48 hours; timing is a risk signal, not proof of fraud.',evidence:[]}});
  }
 }
 for(const group of groups.values()){
  group.sort((a,b)=>a.payment_date<b.payment_date?-1:a.payment_date>b.payment_date?1:a.id<b.id?-1:1);
  for(let i=1;i<group.length;i++){
   const row=group[i]!,prior=group[i-1]!;
   if(Date.parse(row.payment_date)-Date.parse(prior.payment_date)>7*86400000)continue;
   findings.push({amount:canonicalMoney(row.total_amount),currency:paymentRiskCurrency(row)!,finding:{key:riskHash({kind:'repeated_payment_candidate',ids:[prior.id,row.id].sort()}),
    kind:'repeated_payment_candidate',severity:'medium',classification:'candidate',entities:[prior,row].map(p=>({entityType:'supplier_payment',entityId:p.id})),
    message:'Same supplier, exact amount and invoice allocations within seven days; distinct authorized installments may explain this candidate.',evidence:[]}});
  }
 }
 return findings;
}
export async function checkPaymentRisks(ctx:ControlTx,options:RiskCheckOptions={}):Promise<ControlCheckResult>{
 assertControlTx(ctx);await assertEffectivePermission(ctx,'read:invoices');await assertEffectivePermission(ctx,'read:bank-tx');await assertEffectivePermission(ctx,'read:reports');
 const parsed=riskOptions(options),population=await loadPaymentRiskPopulation(ctx,parsed.cutoff),missing:string[]=[];
 const complexity=population.rows.reduce((n,r)=>n+(r.allocation_count??r.allocations.length)+(r.attempt_count??r.attempts.length),0);
 const over=population.populationCount>RISK_SOURCE_LIMIT||complexity>RISK_SOURCE_LIMIT,rows=over?[]:population.rows;
 if(over)missing.push('async_scan_required:payment_source_population_exceeds_10000');
 const eligible=rows.filter(row=>(row.allocation_count??row.allocations.length)<=100&&(row.attempt_count??row.attempts.length)<=100&&paymentRiskCurrency(row));
 if(eligible.length!==rows.length)missing.push('payment_allocation_currency_or_bounded_attempt_evidence_unavailable');
 if(rows.some(row=>row.version===null))missing.push('historical_entity_versions_unavailable');
 if(rows.some(row=>['processed','reconciled'].includes(row.status)&&!row.attempts.length))missing.push('legacy_payment_intent_or_external_confirmation_unavailable');
 const findings=detectPaymentPatterns(eligible);
 if(findings.some(f=>f.finding.kind==='repeated_payment_candidate'))missing.push('independent_installment_authorization_unavailable');
 let beneficiarySources:unknown=[];const bankVersions:EntityVersionRef[]=[];let bankAllowed=true;
 try{await assertEffectivePermission(ctx,'write:bank-tx');}catch(error){if(!(error instanceof EffectivePermissionError))throw error;bankAllowed=false;missing.push('beneficiary_comparison_authority');}
 if(bankAllowed&&!over){
  const bank=await loadRiskBeneficiaries(ctx);
  if(bank.populationCount>RISK_SOURCE_LIMIT)missing.push('async_scan_required:beneficiary_population_exceeds_10000');
  else{const shared=detectSharedRiskBeneficiaries(ctx.principal.companyId,bank.rows);findings.push(...shared.findings);missing.push(...shared.missing);
   beneficiarySources=bank.rows.map(row=>{const fingerprint=beneficiaryFingerprint(ctx.principal.companyId,{domain:'risk-bank-current-v1',row});
    if(row.version!==null)bankVersions.push({entityType:'beneficiary_supplier',entityId:row.id,version:Number(row.version),fingerprint});
    return{id:row.id,version:row.version,fingerprint,pending:row.pending};});}
 }
 return riskResult({id:'payment_risk_checks',options,populationCount:population.populationCount,excludedCount:rows.filter(r=>!['approved','processed','reconciled'].includes(r.status)).length,
  findings,missing,coverage:['owned_supplier_payments','same_invoice_allocations_within_7_days','immutable_release_preparation_attempts','supplier_verified_account_reuse_requires_write_bank_tx',
   'verified_change_within_48_hours_before_activity','current_values_at_accounting_cutoff','synchronous_population_limit_10000','amount_totals_are_signal_exposures_and_can_overlap'],
  capturedAt:population.capturedAt,sourceHash:riskHash({rows,beneficiaries:beneficiarySources}),sourceVersions:[...bankVersions,...rows.filter(r=>r.version!==null).map(r=>({entityType:'supplier_payment',entityId:r.id,version:Number(r.version),fingerprint:riskHash(r)}))]});
}
