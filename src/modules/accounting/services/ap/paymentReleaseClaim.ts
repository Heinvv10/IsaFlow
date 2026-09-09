import {loadAuthorizedPaymentRelease} from './paymentReleaseAuthority';
import {randomUUID} from 'node:crypto';
import type {ControlTx} from '../controls/contracts';
import {loadPaymentReleaseIntent} from './paymentReleaseMaterializer';
import {recordBatchEntity} from './batchPaymentWriteService';
export interface ReleaseClaim {intentId:string;attemptId:string;providerReference:string;payload:Awaited<ReturnType<typeof loadPaymentReleaseIntent>>['payload'];serviceKey:string;payoutsKey:string}
/** Returned data is internal; caller must prove COMMIT before transmitting it. */
export async function claimPaymentRelease(ctx:ControlTx,intentId:string):Promise<ReleaseClaim|null>{
 const company=ctx.principal.companyId;
 const {release,outbox}=await loadAuthorizedPaymentRelease(ctx,intentId);
 if(outbox.state!=='ready')return null; // Attempting/unknown/terminal never retransmit.
 let serviceKey='',payoutsKey='';
 if(release.intent.channel==='netcash'){
  const [keys]=await ctx.sql`SELECT netcash_service_key,netcash_payouts_key FROM companies WHERE id=${company}::uuid FOR SHARE` as Array<{netcash_service_key:string;netcash_payouts_key:string}>;
  if(!keys?.netcash_service_key||!keys.netcash_payouts_key)throw new Error('Provider credentials unavailable');
  serviceKey=keys.netcash_service_key;payoutsKey=keys.netcash_payouts_key;
 }
 const attemptId=randomUUID();
 const [after]=await ctx.sql`UPDATE control_payment_release_outbox SET state='attempting',attempt_id=${attemptId}::uuid,attempted_at=clock_timestamp()
  WHERE company_id=${company}::uuid AND intent_id=${intentId}::uuid AND state='ready' RETURNING *,intent_id AS id` as Array<Record<string,unknown>>;
 if(!after)throw new Error('Release already claimed');
 await recordBatchEntity(ctx,'payment_release_outbox',outbox,after,'payment_release.attempting');
 const claim=Object.freeze({intentId,attemptId,providerReference:String(outbox.provider_reference),payload:release.payload,serviceKey,payoutsKey});
 return claim;
}
