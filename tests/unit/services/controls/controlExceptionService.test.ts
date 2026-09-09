import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({check:vi.fn(),permission:vi.fn(),sql:vi.fn(),store:{controlWriteFailed:false}}));
vi.mock('@/lib/als',()=>({als:{getStore:()=>mocks.store}}));
vi.mock('@/lib/neon',()=>({withSavepoint:async(name:string,fn:()=>Promise<unknown>)=>{if(!/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/.test(name))throw new Error('Invalid savepoint name');await Promise.resolve();return fn();}}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:()=>{}}));
vi.mock('@/modules/accounting/services/controls/controlExceptionRecheck',()=>({runExceptionCheck:mocks.check,assertExceptionReadPermission:mocks.permission}));
import {resolveControlException,listControlExceptions} from '@/modules/accounting/services/controls/controlExceptionService';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const ctx={principal:{companyId:'tenant',personId:'reviewer',authMethod:'cookie',provenance:'human'},sql:mocks.sql} as unknown as ControlTx;
const id='ad27508a-1f27-4ed3-9ad3-a5e14a47a6ba';
const row={id,company_id:'tenant',check_id:'three_way_match_exceptions',check_version:1,finding_key:'target',version:1,severity:'high',status:'open',reporter_person_id:'reporter',owner_person_id:'owner',cutoff:null,due_at:null,risk_expires_at:null,first_seen_at:new Date(),last_seen_at:new Date(),updated_at:new Date()};
beforeEach(()=>{vi.clearAllMocks();mocks.store.controlWriteFailed=false;mocks.sql.mockResolvedValue([row]);});
it('persists a blocked failed server recheck instead of marking the exception fixed',async()=>{
 mocks.check.mockResolvedValue({checkId:row.check_id,checkVersion:1,status:'fail',findingCount:1,findings:[],nextCursor:null,missingSources:[],sourceVersions:[]});
 const result=await resolveControlException(ctx,{exceptionId:id,expectedVersion:1,resolution:'fixed',reason:'Correction attempted'});
 expect(result.outcome).toBe('recheck_blocked');
});
it('refuses a high risk owner using a different identity token',async()=>{
 mocks.sql.mockResolvedValue([{...row,owner_person_id:'reviewer'}]);
 await expect(resolveControlException(ctx,{exceptionId:id,expectedVersion:1,resolution:'accepted_risk',reason:'Reviewed',expiresAt:'2099-01-01T00:00:00Z'})).rejects.toThrow(/Independent/);
 expect(mocks.store.controlWriteFailed).toBe(true);
});
it('rejects stale versions before deciding',async()=>{
 await expect(resolveControlException(ctx,{exceptionId:id,expectedVersion:2,resolution:'fixed',reason:'Correction'})).rejects.toThrow(/version/);
});
it('retains a blocked outcome when the actual server checker errors',async()=>{
 mocks.check.mockRejectedValue(new Error('Source query unavailable'));
 const result=await resolveControlException(ctx,{exceptionId:id,expectedVersion:1,resolution:'fixed',reason:'Correction attempted'});
 expect(result.outcome).toBe('recheck_blocked');expect(mocks.store.controlWriteFailed).toBe(false);
});

it('detaches list filters before awaiting current permission checks',async()=>{
 const input={checkId:'three_way_match_exceptions',status:'open'};
 mocks.permission.mockImplementationOnce(async()=>{input.status='accepted_risk';});
 await listControlExceptions(ctx,input);
 const values=mocks.sql.mock.calls[0]!.slice(1);expect(values).toContain('open');expect(values).not.toContain('accepted_risk');
});
it('rejects list accessors without invoking caller code',async()=>{
 let reads=0;await expect(listControlExceptions(ctx,{get checkId(){reads++;return 'three_way_match_exceptions';}})).rejects.toThrow();expect(reads).toBe(0);
});

it('detaches resolution input before the savepoint await',async()=>{
 const input={exceptionId:id,expectedVersion:1,resolution:'accepted_risk',reason:'Reviewed',expiresAt:'2099-01-01T00:00:00Z'};
 const pending=resolveControlException(ctx,input);input.resolution='fixed';input.expiresAt='2000-01-01T00:00:00Z';
 expect((await pending).outcome).toBe('accepted_risk');
});
