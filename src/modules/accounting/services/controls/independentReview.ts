import {als} from '@/lib/als';
import {isPlatformAdminRequest} from '@/lib/auth/platformImportAuthority';
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
 // The ONE blanket allow, and a deliberate one: no request context at all is a script or
 // a background task run by an operator with database credentials, not a session anyone
 // is signing a decision in.
 if(!store)return;
 // Inside a request context the answer defaults to no. Every principal-less context in
 // this codebase - the platform-admin request, invite and extension tokens, MCP
 // invocation persistence, the audit-worker poller and lease, the portfolio workbench -
 // either issues its own fixed SQL or serves a flow that records no approver, so none of
 // them needs to be allowed through here. Anything that reaches this line without a
 // principal is either one of those (which should not be approving) or a new path nobody
 // has weighed, and both must fail visibly rather than approve quietly.
 if(!store.controlPrincipal){
  // A verified global-administrator request is named in the refusal: it is the one
  // principal-less context an operator is likely to meet, and plain-SQL approver writes
  // (AFS sign-off and lock, tax directives, leave, commentary) have nothing downstream
  // that would stop it. The Sage migration commit needs its own confined route.
  if(isPlatformAdminRequest(store))throw new Error('A platform administrator is not an independent reviewer');
  throw new Error('This request context cannot record an independent review');
 }
 assertIndependentHumanReview(store.controlPrincipal,requesterPersonId);
}
/** The actor to record next to an approver who is not blocked from signing. */
export function requestImpersonator():string|null{
 return als.getStore()?.controlPrincipal?.impersonatorPersonId??null;
}
