import {bankFingerprint,normalizeBeneficiaryDetails,openBeneficiary} from './beneficiaryValidation';
import {beneficiaryFingerprint} from './changeProtection';
import type {RiskBeneficiaryRow} from './invoiceRiskQueriesBeneficiaries';
import {riskHash,type RiskFinding} from './invoiceRiskQueriesResult';
/** Bank values remain private; returned findings contain only owned supplier/version references. */
export function detectSharedRiskBeneficiaries(companyId:string,rows:readonly RiskBeneficiaryRow[]){
 const groups=new Map<string,RiskBeneficiaryRow[]>(),missing:string[]=[];
 for(const row of rows){
  if(!row.version_id||!row.details_envelope||!row.fingerprint){missing.push('unverified_supplier_beneficiary_versions');continue;}
  if(row.pending){missing.push('supplier_beneficiary_pending_hold');continue;}
  try{
   const ref={entityType:'supplier' as const,entityId:row.id};
   const details=openBeneficiary(companyId,ref,row.details_envelope,row.fingerprint);
   const current=normalizeBeneficiaryDetails({bankName:row.bank_name,accountNumber:row.bank_account_number,branchCode:row.bank_branch_code,accountType:row.bank_account_type});
   if(bankFingerprint(companyId,ref,current)!==row.fingerprint){missing.push('supplier_bank_changed_outside_verified_version');continue;}
   const key=beneficiaryFingerprint(companyId,{domain:'risk-shared-account-v1',accountNumber:details.accountNumber,branchCode:details.branchCode});
   const group=groups.get(key)??[];group.push(row);groups.set(key,group);
  }catch{missing.push('supplier_beneficiary_integrity_unavailable');}
 }
 const findings:RiskFinding[]=[];
 for(const group of groups.values()){
  group.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  for(const row of group.slice(1))findings.push({amount:'0',currency:'ZAR',finding:{key:riskHash({kind:'shared_supplier_bank',ids:[group[0]!.id,row.id]}),
   kind:'shared_supplier_bank',severity:'high',classification:'confirmed',entities:[group[0]!,row].map(r=>({entityType:'supplier',entityId:r.id})),
   message:'Distinct suppliers currently share the same verified account and branch. Shared collection arrangements may be legitimate; investigate ownership.',
   evidence:[]}});
 }
 return{findings,missing};
}
