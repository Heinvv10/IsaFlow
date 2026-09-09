import {UUID_RE} from '@/lib/validation';
import {EFT_FORMATS,type ReleaseChannel,type ReleaseBankFormat} from './paymentReleasePayload';
export type ReleaseAction={action:'prepare';batchId:string;bank?:ReleaseBankFormat}
 |{action:'release';intentId:string;approvalId:string}|{action:'download';intentId:string};
/** Financial instructions are fixed owned references; raw beneficiary instructions never enter here. */
export function parsePaymentReleaseAction(channel:ReleaseChannel,value:unknown):ReleaseAction {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Explicit payment release action required');
 const input=value as Record<string,unknown>;
 const exact=(keys:string[])=>{if(Object.keys(input).some(key=>!keys.includes(key)))throw new Error('Unsupported payment release field');};
 const id=(value:unknown)=>{if(typeof value!=='string'||!UUID_RE.test(value))throw new Error('Owned payment reference required');return value;};
 if(input.action==='prepare'){
  if(channel==='netcash'){exact(['action','batchPaymentId']);return{action:'prepare',batchId:id(input.batchPaymentId)};}
  exact(['action','batchId','bank']);
  if(typeof input.bank!=='string'||!EFT_FORMATS.includes(input.bank as ReleaseBankFormat))throw new Error('Supported EFT bank required');
  return{action:'prepare',batchId:id(input.batchId),bank:input.bank as ReleaseBankFormat};
 }
 if(input.action==='release'){exact(['action','intentId','approvalId']);return{action:'release',intentId:id(input.intentId),approvalId:id(input.approvalId)};}
 if(input.action==='download'&&channel==='eft'){exact(['action','intentId']);return{action:'download',intentId:id(input.intentId)};}
 throw new Error('Explicit payment release action required');
}
