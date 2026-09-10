import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {mintImpersonationProof} from '@/lib/auth/impersonationAssurance';
const delegation=vi.hoisted(()=>({live:vi.fn(async()=>true)}));
vi.mock('@/lib/auth/impersonationDelegation',()=>({impersonationDelegationLive:delegation.live}));
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
  stashId:'22222222-2222-4222-8222-222222222222',actorExpiresAt:now+3600,stashExpiresAt:now+3600});
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
it('marks every session unverified when the reader function is not deployed',async()=>{
 reader(false,undefined);
 // Fail closed on the request path: an admin who drops the proof cookie against a member
 // with no verified factor would otherwise be recorded as the member with no actor at all.
 // The cost - approvals refused - is a deploy-gate failure, not a runtime surprise:
 // assertImpersonationReaderDeployed is what keeps this state off a live database.
 expect(await resolveImpersonatingActor(client,claims,undefined)).toBe(IMPERSONATION_UNVERIFIED);
 expect(await resolveImpersonatingActor(client,claims,'not-a-usable-proof')).toBe(IMPERSONATION_UNVERIFIED);
 expect(()=>assertIndependentHumanReview(principal(IMPERSONATION_UNVERIFIED),'requester'))
  .toThrow('Impersonation state is unverified; an independent review cannot be recorded');
});
it.each([
 // A missing function and a missing grant need different remediation, so the gate names which.
 ['reader missing',{reader:false,liveness:true,reader_exec:null,liveness_exec:true},/control_session_impersonator\(\) is not deployed/],
 ['liveness missing',{reader:true,liveness:false,reader_exec:true,liveness_exec:null},/impersonation_delegation_live\(.*\) is not deployed/],
 ['app_user cannot execute the reader',{reader:true,liveness:true,reader_exec:false,liveness_exec:true},/app_user.*control_session_impersonator/],
 // Liveness runs from verifyToken on the DATABASE_URL login role, not as app_user.
 ['the login role cannot execute liveness',{reader:true,liveness:true,reader_exec:true,liveness_exec:false,login_role:'app_login'},/app_login cannot EXECUTE .*impersonation_delegation_live/],
] as const)('fails the deploy gate when %s',async(_name,row,message)=>{
 const {assertImpersonationReaderDeployed}=await import('@/lib/auth/sessionImpersonation');
 // Missing EXECUTE would make every authenticated request 500 while an existence check passed.
 await expect(assertImpersonationReaderDeployed(async()=>[row])).rejects.toThrow(message);
});
it('passes the deploy gate only when both functions exist and app_user may execute both',async()=>{
 const {assertImpersonationReaderDeployed}=await import('@/lib/auth/sessionImpersonation');
 await expect(assertImpersonationReaderDeployed(async()=>[{reader:true,liveness:true,reader_exec:true,liveness_exec:true}]))
  .resolves.toBeUndefined();
});
it('is reached from withAuth and nowhere else',async()=>{
 // An approver path outside withAuth would carry no impersonation marking at all, so the
 // single call site is the invariant. This is an architecture assertion, deliberately.
 const {execFileSync}=await import('node:child_process');
 const hits=execFileSync('git',['grep','-l','resolveImpersonatingActor(','--','src','pages'],{encoding:'utf8'})
  .split('\n').filter(Boolean).filter(file=>file!=='src/lib/auth/sessionImpersonation.ts');
 expect(hits).toEqual(['src/lib/auth/withAuth.ts']);
});
it('stops re-checking the reader function once it is present',async()=>{
 reader(true,{actor:null});
 await resolveImpersonatingActor(client,claims,undefined);
 await resolveImpersonatingActor(client,claims,undefined);
 expect(query.mock.calls.filter(call=>String(call[0]).includes('to_regprocedure'))).toHaveLength(1);
});
