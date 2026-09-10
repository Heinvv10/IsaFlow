import {expect,it,vi} from 'vitest';
import {legacyImpersonationTargetsSql,revokeLegacyImpersonationSessions} from '../../../scripts/revoke-legacy-impersonation-sessions';

const rows=[{target_id:'user-a',email:'a@test.local'},{target_id:'user-b',email:null}];
const deps=(revoke=vi.fn(async()=>undefined))=>({
 query:vi.fn(async()=>rows),revoke,log:vi.fn(),
});

it('selects only impersonation starts that recorded no target session',()=>{
 expect(legacyImpersonationTargetsSql).toContain("action='impersonation_start'");
 expect(legacyImpersonationTargetsSql).toContain("details->>'target_session_id' IS NULL");
});
it('counts the affected targets and revokes nothing without an explicit apply',async()=>{
 const d=deps();
 expect(await revokeLegacyImpersonationSessions({...d,apply:false})).toEqual({targets:2,revoked:0,failed:0});
 expect(d.revoke).not.toHaveBeenCalled();
});
it('revokes every unrecorded target once when applied',async()=>{
 const d=deps();
 expect(await revokeLegacyImpersonationSessions({...d,apply:true})).toEqual({targets:2,revoked:2,failed:0});
 expect(d.revoke.mock.calls).toEqual([['user-a','a@test.local'],['user-b',undefined]]);
});
it('reports a failed revocation instead of claiming the session was cleared',async()=>{
 const revoke=vi.fn(async(id:string)=>{if(id==='user-a')throw new Error('gotrue logout failed: 503');});
 const d=deps(revoke);
 expect(await revokeLegacyImpersonationSessions({...d,apply:true})).toEqual({targets:2,revoked:1,failed:1});
});
