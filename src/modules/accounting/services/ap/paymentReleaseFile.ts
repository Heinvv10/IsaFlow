import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from '../controls/context';
import type {ControlTx} from '../controls/contracts';
import {generateStandardBankACB,generateFNBEFT,generateABSAEFT,generateNedbankEFT,generateCapitecEFT} from './eftService';
import type {PaymentReleasePayload} from './paymentReleasePayload';
import {validateReleaseFileFields} from './paymentReleasePayload';
import {loadAuthorizedPaymentRelease} from './paymentReleaseAuthority';
export function renderReleasedEft(payload:PaymentReleasePayload):string{
 if(payload.channel!=='eft'||!payload.bankFormat)throw new Error('EFT release required');
 validateReleaseFileFields(payload.header,payload.payments);
 const generators={standard_bank:generateStandardBankACB,fnb:generateFNBEFT,absa:generateABSAEFT,nedbank:generateNedbankEFT,capitec:generateCapitecEFT};
 return generators[payload.bankFormat](payload.header,payload.payments);
}
/** Explicit authorized bank-file response only. Never call from generic history, tools, or graph projection. */
export async function getReleasedEftFile(ctx:ControlTx,intentId:string){
 assertControlTx(ctx);await assertEffectivePermission(ctx,'write:release');await assertEffectivePermission(ctx,'write:bank-tx');
 const {release,outbox}=await loadAuthorizedPaymentRelease(ctx,intentId);
 if(outbox.state!=='exported')throw new Error('Authorized EFT artifact is not ready');
 return{filename:`EFT-${release.payload.bankFormat}-${intentId}.txt`,content:renderReleasedEft(release.payload),intentId,
  bank:release.payload.bankFormat,paymentCount:release.payments.length,totalAmount:release.amount};
}
