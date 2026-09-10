import type {ControlPrincipal} from './contracts';
/** The session's impersonation state could not be established (the reader function is not deployed). */
export const IMPERSONATION_UNVERIFIED='impersonation-state-unverified';
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
