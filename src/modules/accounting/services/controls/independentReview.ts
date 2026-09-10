import {als} from '@/lib/als';
import type {ControlPrincipal} from './contracts';
import {IMPERSONATION_UNVERIFIED} from '@/lib/auth/impersonationState';
export {IMPERSONATION_UNVERIFIED};
/**
 * Segregation of duties is about people, not cookies. A platform administrator
 * impersonating a member holds that member's session, so every ordinary
 * permission check passes and the recorded decision carries the member's id —
 * which is exactly why an impersonated session can never be the independent
 * human review a controlled operation requires. Requester identity is passed in
 * so a maker approving his own work through an impersonated reviewer is named
 * as the self approval it is.
 */
export function assertIndependentHumanReview(principal:ControlPrincipal,requesterPersonId:string|null):void{
 const actor=principal.impersonatorPersonId;
 if(!actor)return;
 if(actor===IMPERSONATION_UNVERIFIED)throw new Error('Impersonation state is unverified; an independent review cannot be recorded');
 if(requesterPersonId&&actor===requesterPersonId)throw new Error('Impersonated self approval is not permitted');
 throw new Error('An impersonated session cannot record an independent review');
}
/**
 * Same rule for approver-of-record workflows outside the controls kernel: they
 * take a userId rather than a principal, so the authenticated request context is
 * where the impersonating actor is found. A caller with no request context (a
 * script, a background task) is not a browser session and is left alone.
 */
export function assertIndependentRequestReview(requesterPersonId:string|null=null):void{
 const store=als.getStore();
 // No request context at all is a script or a background task, not a browser session.
 if(!store)return;
 // A request context with no tenant principal is a platform-admin request: a global
 // administrator acting directly on a tenant's ledger, which is what the confined
 // platform-import path exists to replace. It is not an independent tenant review.
 if(!store.controlPrincipal)throw new Error('A platform administrator is not an independent reviewer');
 assertIndependentHumanReview(store.controlPrincipal,requesterPersonId);
}
/** The actor to record next to an approver who is not blocked from signing. */
export function requestImpersonator():string|null{
 return als.getStore()?.controlPrincipal?.impersonatorPersonId??null;
}
