import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {requireControlTx} from '../controls/context';
import {parsePaymentReleaseAction} from './paymentReleaseAction';
import type {ReleaseChannel} from './paymentReleasePayload';
import {createPaymentReleaseIntent,enqueuePaymentRelease} from './paymentReleaseService';
import {schedulePaymentReleaseDispatch} from './paymentReleaseDispatcher';
import {getReleasedEftFile} from './paymentReleaseFile';
/** Shared REST/UI adapter. Preparation and independent approval remain separate persisted operations. */
export async function performPaymentReleaseAction(channel:ReleaseChannel,input:unknown){
 const action=parsePaymentReleaseAction(channel,input),ctx=requireControlTx();
 await assertEffectivePermission(ctx,'write:release');
 if(action.action==='prepare')return createPaymentReleaseIntent(ctx,{batchId:action.batchId,channel,bankFormat:action.bank});
 const [intent]=await ctx.sql`SELECT channel FROM control_payment_release_intents
  WHERE company_id=${ctx.principal.companyId}::uuid AND id=${action.intentId}::uuid` as Array<{channel:string}>;
 if(intent?.channel!==channel)throw new Error('Owned release for this channel required');
 if(action.action==='download')return getReleasedEftFile(ctx,action.intentId);
 const result=await enqueuePaymentRelease(ctx,action.intentId,action.approvalId);
 await schedulePaymentReleaseDispatch(ctx,action.intentId);
 return result;
}
