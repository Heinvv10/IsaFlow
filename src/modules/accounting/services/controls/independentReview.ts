import {als} from '@/lib/als';
import {log} from '@/lib/logger';
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
 // them needs to be allowed through here - except the platform-admin request, below, for
 // a reason that is recorded there. Anything else that reaches this line without a
 // principal is either one of those (which should not be approving) or a new path nobody
 // has weighed, and both must fail visibly rather than approve quietly.
 if(!store.controlPrincipal){
  // A verified global-administrator request is the one principal-less context that still
  // gets through, and only because the Sage migration commit has no other route today:
  // withPlatformImportTarget cannot carry it (its ceiling grants no write:invoices and its
  // confinement admits only historical_import.post), so refusing here would fail every AP
  // invoice of a migration into a counts summary. It is recorded at error level on every
  // call, and impersonatedApproverCensus.int.test.ts fails the day the refusal lands.
  if(isPlatformAdminRequest(store)){
   log.error('platform administrator recorded an approver of record on a tenant ledger',{},'controls');
   return;
  }
  throw new Error('This request context cannot record an independent review');
 }
 assertIndependentHumanReview(store.controlPrincipal,requesterPersonId);
}
/** The actor to record next to an approver who is not blocked from signing. */
export function requestImpersonator():string|null{
 return als.getStore()?.controlPrincipal?.impersonatorPersonId??null;
}
