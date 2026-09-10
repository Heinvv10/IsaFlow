import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {mintImpersonationProof} from '@/lib/auth/impersonationAssurance';
import {resolveImpersonatingActor,resetImpersonationReaderCache} from '@/lib/auth/sessionImpersonation';
import {assertIndependentHumanReview,IMPERSONATION_UNVERIFIED} from '@/modules/accounting/services/controls/independentReview';
import type {ControlPrincipal} from '@/modules/accounting/services/controls/contracts';

const actor='00000000-0000-4000-8000-0000000000a1',target='00000000-0000-4000-8000-0000000000b2';
const claims={sub:target,session_id:'target-session'};
const query=vi.fn(),client={query} as unknown as PoolClient;
const principal=(impersonatorPersonId:string|null)=>({impersonatorPersonId} as unknown as ControlPrincipal);
function reader(available:boolean,row:{actor:string|null}|undefined){
 query.mockImplementation(async(text:string)=>text.includes('to_regprocedure')
  ?{rows:[{available}]}:{rows:row?[row]:[]});
}
beforeEach(()=>{vi.stubEnv('JWT_SECRET','synthetic-session-impersonation-secret-forty-chars');query.mockReset();resetImpersonationReaderCache();});

it('names the delegated actor from the proof without consulting the database',async()=>{
 const now=Math.floor(Date.now()/1000);
 const proof=await mintImpersonationProof({actorUserId:actor,targetUserId:target,targetSessionId:'target-session',
  actorExpiresAt:now+3600,stashExpiresAt:now+3600});
 reader(true,{actor:null});
 expect(await resolveImpersonatingActor(client,claims,proof)).toBe(actor);
 expect(query).not.toHaveBeenCalled();
});
it('falls back to the recorded impersonation session when no proof cookie is presented',async()=>{
 reader(true,{actor});
 expect(await resolveImpersonatingActor(client,claims,undefined)).toBe(actor);
});
it('leaves an ordinary session unflagged',async()=>{
 reader(true,{actor:null});
 expect(await resolveImpersonatingActor(client,claims,undefined)).toBeNull();
 expect(assertIndependentHumanReview(principal(null),'someone')).toBeUndefined();
});
it('refuses reviews rather than every request when the reader function is not deployed',async()=>{
 reader(false,undefined);
 expect(await resolveImpersonatingActor(client,claims,undefined)).toBe(IMPERSONATION_UNVERIFIED);
 // Ordinary requests keep working; only a recorded human review fails closed.
 expect(()=>assertIndependentHumanReview(principal(IMPERSONATION_UNVERIFIED),'requester'))
  .toThrow('Impersonation state is unverified; an independent review cannot be recorded');
 expect(query.mock.calls.every(call=>String(call[0]).includes('to_regprocedure'))).toBe(true);
});
it('stops re-checking the reader function once it is present',async()=>{
 reader(true,{actor:null});
 await resolveImpersonatingActor(client,claims,undefined);
 await resolveImpersonatingActor(client,claims,undefined);
 expect(query.mock.calls.filter(call=>String(call[0]).includes('to_regprocedure'))).toHaveLength(1);
});
