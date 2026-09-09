import {createHmac,createHash} from 'node:crypto';
import {canonicalJson} from '../controls/canonical';
export function releaseConfigurationFingerprint(companyId:string,serviceKey:string,payoutsKey:string){
 const key=process.env.CONTROL_FINGERPRINT_KEY;if(!key||key.length<32)throw new Error('Release fingerprint key unavailable');
 return createHmac('sha256',key).update(JSON.stringify({domain:'payment-release-provider-v1',companyId,serviceKey,payoutsKey})).digest('hex');
}

export function releaseSourceFingerprint(batch:{id:string;status:string;bank_account_id:string|null;batch_date:string},payments:readonly {payment:{id:string};releaseObservation:string}[]){
 return createHash('sha256').update(canonicalJson({batch:{id:batch.id,status:batch.status,bankAccountId:batch.bank_account_id,date:batch.batch_date},
  payments:payments.map(p=>({id:p.payment.id,observation:p.releaseObservation})).sort((a,b)=>a.id.localeCompare(b.id))})).digest('hex');
}
