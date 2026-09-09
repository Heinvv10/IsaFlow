import {assertReleaseApprovalCurrent} from './paymentReleaseValidation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {approvalAuthorities,lockApproval,assertRequesterAuthority,approvalDecisions,validateDecisions} from '../controls/approvalQueries';
import {loadOperationMaterial} from '../controls/operationMaterializer';
import {operationBindingHash} from '../controls/canonical';
import type {ControlTx} from '../controls/contracts';
import {loadPaymentReleaseIntent} from './paymentReleaseMaterializer';
import {assertControlTx} from '../controls/context';
/** Revalidate human authority, original expiry, exact current binding and reservations at every delivery boundary. */
export async function loadAuthorizedPaymentRelease(ctx:ControlTx,intentId:string){
 assertControlTx(ctx);
 const company=ctx.principal.companyId;
 const [initial]=await ctx.sql`SELECT approval_id FROM control_payment_release_outbox WHERE company_id=${company}::uuid AND intent_id=${intentId}::uuid` as Array<{approval_id:string}>;
 if(!initial)throw new Error('Queued release not found');
 const authorities=await approvalAuthorities(ctx,initial.approval_id);
 await assertEffectivePermission(ctx,'write:release');await assertEffectivePermission(ctx,'write:bank-tx');
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${company}`},0))`;
 const approval=await lockApproval(ctx,initial.approval_id);
 assertReleaseApprovalCurrent(approval);
 if(approval.status!=='consumed'||approval.binding.entityId!==intentId||approval.binding.operation!=='payment_release.dispatch'
  ||approval.requester_person_id!==ctx.principal.personId||!approval.binding.policies.some(p=>p.mandatory))throw new Error('Consumed independent release authority required');
 await assertRequesterAuthority(approval,authorities);await validateDecisions(ctx,approval,await approvalDecisions(ctx,approval.id),authorities);
 const [outbox]=await ctx.sql`SELECT *,intent_id AS id FROM control_payment_release_outbox WHERE company_id=${company}::uuid AND intent_id=${intentId}::uuid FOR UPDATE` as Array<Record<string,unknown>>;
 if(!outbox)throw new Error('Release outbox missing');
 const material=await loadOperationMaterial(ctx,{entityType:'payment_release_intent',entityId:intentId,operation:'payment_release.dispatch'});
 // Consuming the approval increments only the immutable intent's observation version.
 const current={...material.binding,entityVersion:approval.binding.entityVersion,
  sourceVersions:material.binding.sourceVersions.map(source=>source.entityType==='payment_release_intent'&&source.entityId===intentId
   ?{...source,version:approval.binding.sourceVersions.find(old=>old.entityType===source.entityType&&old.entityId===source.entityId)!.version}:source)};
 if(operationBindingHash(current)!==approval.binding_hash)throw new Error('Release approval material changed');
 const release=await loadPaymentReleaseIntent(ctx,intentId);
 if(release.intent.requester_person_id!==ctx.principal.personId)throw new Error('Release requester required');
 const reservations=await ctx.sql`SELECT payment_id FROM control_payment_release_reservations WHERE company_id=${company}::uuid AND intent_id=${intentId}::uuid ORDER BY payment_id` as Array<{payment_id:string}>;
 if(reservations.length!==release.payments.length||reservations.some((row,i)=>row.payment_id!==release.payments[i]!.payment.id))throw new Error('Release reservation population changed');
 return{release,outbox};
}
