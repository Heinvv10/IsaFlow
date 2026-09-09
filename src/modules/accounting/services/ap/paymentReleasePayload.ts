import {createHash} from 'node:crypto';
import {canonicalJson} from '../controls/canonical';
import {protectChangeValues,openProtectedChange,type ProtectedChange} from '../controls/changeProtection';
import type {EFTBatchHeader,EFTPayment} from './eftService';
export const EFT_FORMATS=['standard_bank','fnb','absa','nedbank','capitec'] as const;
export type ReleaseChannel='netcash'|'eft';
export type ReleaseBankFormat=typeof EFT_FORMATS[number];
export interface PaymentReleasePayload {
 version:1;companyId:string;intentId:string;channel:ReleaseChannel;bankFormat:ReleaseBankFormat|null;
 providerConfigurationFingerprint:string|null;sourceFingerprint:string;header:EFTBatchHeader;payments:EFTPayment[];
}
export function sealReleasePayload(payload:PaymentReleasePayload){
 const json=canonicalJson(payload),hash=createHash('sha256').update(json).digest('hex');
 const envelope=protectChangeValues('payment_release_payload',null,JSON.parse(json) as Record<string,unknown>).protectedPayload;
 return{hash,envelope};
}
export function openReleasePayload(companyId:string,intentId:string,envelope:ProtectedChange,hash:string):PaymentReleasePayload{
 try{
  const payload=openProtectedChange(envelope).after;
  if(!payload||payload.companyId!==companyId||payload.intentId!==intentId||payload.version!==1
   ||typeof payload.sourceFingerprint!=='string'||!/^([a-f0-9]{64})$/.test(payload.sourceFingerprint)
   ||createHash('sha256').update(canonicalJson(payload)).digest('hex')!==hash)throw new Error('binding');
  return payload as unknown as PaymentReleasePayload;
 }catch{throw new Error('Payment release payload unavailable or changed');}
}
/** The legacy fixed-width writers truncate; reject before handing them any value that would be truncated. */
export function validateReleaseFileFields(header:EFTBatchHeader,payments:readonly EFTPayment[]):void{
 const text=(value:string,max:number)=>{if(!value||value.length>max||/[\r\n,\u0000-\u001f]/.test(value))throw new Error('Payment file field cannot be represented safely');};
 const account=(value:string)=>{if(!/^\d{1,11}$/.test(value))throw new Error('Payment file account cannot be represented safely');};
 text(header.companyName,30);text(header.batchReference,12);account(header.bankAccountNumber);
 if(!/^\d{6}$/.test(header.branchCode))throw new Error('Invalid bank branch');
 for(const payment of payments){text(payment.beneficiaryName,30);text(payment.reference,12);account(payment.beneficiaryAccountNumber);
  if(!/^\d{6}$/.test(payment.beneficiaryBranchCode))throw new Error('Invalid beneficiary branch');}
}
