/** Legacy entry points share the persisted asset-period control used by every transport. */
import { fmtDate } from '@/lib/fmtDate';
import { isRealCalendarDate } from '@/lib/validation';
import { log } from '@/lib/logger';
import { prepareAssetDepreciation, executeAssetDepreciation } from './controlledAssetDepreciation';
interface ApprovalOptions { approvalId?:string }
interface DualDepInput {
 cost:number; residualPct:number; usefulLifeYears:number; taxLifeYears:number;
 purchaseDate:string; periodDate:string; openingAccDep:number; taxOpeningAccDep:number;
 deferredTaxRate:number; disposalDate?:string;
}
export interface DualDepResult {
 policyDep:number; taxDep:number; entryId:string|null; glFailed:boolean;
 intentId:string; requiresApproval:boolean;
}
/** The old amount is advisory compatibility input. Actual financial amounts are always read from persisted asset facts. */
export async function postAssetDepreciationToGL(companyId:string,assetId:string,_depreciationAmount:number,userId:string,
 options?:ApprovalOptions&{periodDate?:string}):Promise<string|null>{
 const periodDate=options?.periodDate??fmtDate(new Date());
 const prepared=await prepareAssetDepreciation(companyId,userId,assetId,periodDate);
 const result=await executeAssetDepreciation(companyId,userId,prepared.intentId,options);
 return result.journalEntryId;
}
/** Caller calculations never write ledger amounts. Preparation survives an approval refusal so a human can review the same intent. */
export async function postDualDepreciationToLedger(companyId:string,assetId:string,input:DualDepInput,yyyymm:string,userId:string,
 options?:ApprovalOptions):Promise<DualDepResult>{
 if(!isRealCalendarDate(input.periodDate)||yyyymm!==input.periodDate.slice(0,7).replace('-',''))throw new Error('Depreciation month does not match accounting date');
 const prepared=await prepareAssetDepreciation(companyId,userId,assetId,input.periodDate);
 try{
  const result=await executeAssetDepreciation(companyId,userId,prepared.intentId,options);
  return{policyDep:Number(result.policyDep),taxDep:Number(result.taxDep),entryId:result.journalEntryId,glFailed:false,
   intentId:prepared.intentId,requiresApproval:false};
 }catch(error){
  log.warn('Controlled depreciation did not post',{assetId,intentId:prepared.intentId,error},'accounting');
  return{policyDep:0,taxDep:0,entryId:null,glFailed:true,intentId:prepared.intentId,requiresApproval:prepared.requiresApproval&&!options?.approvalId};
 }
}
