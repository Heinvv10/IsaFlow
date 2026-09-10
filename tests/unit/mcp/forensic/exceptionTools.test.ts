import {beforeEach,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({capture:vi.fn(),list:vi.fn(),assign:vi.fn(),resolve:vi.fn(),authorize:vi.fn(),permission:vi.fn(),read:vi.fn(),ctx:{principal:{companyId:'company',personId:'person'}}}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>mock.ctx}));
vi.mock('@/modules/accounting/services/controls/controlExceptionService',()=>({captureControlExceptions:mock.capture,listControlExceptions:mock.list,assignControlException:mock.assign,resolveControlException:mock.resolve,authorizeControlExceptionTransition:mock.authorize}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mock.permission}));
vi.mock('@/modules/accounting/services/controls/controlExceptionRecheck',()=>({assertExceptionReadPermission:mock.read}));
import {forensicExceptionTools} from '@/lib/mcp/tools/forensicExceptions';
const id='11111111-1111-4111-8111-111111111111';
const context={companyId:'company'} as never;
const tool=(name:string)=>forensicExceptionTools.find(t=>t.name===name)!;
beforeEach(()=>{vi.clearAllMocks();for(const fn of [mock.capture,mock.list,mock.assign,mock.resolve])fn.mockResolvedValue({actual:'shared'});mock.authorize.mockResolvedValue(undefined);});
it('separates retained read from explicit capture and delegates canonical fields',async()=>{
 const read=tool('control_exceptions'),capture=tool('capture_control_exceptions');expect(read.write).toBe(false);expect(capture.write).toBe(true);expect(capture.scope).toBe('write:approvals');
 await read.handler({check_id:'three_way_match_exceptions',limit:1},context);expect(mock.capture).not.toHaveBeenCalled();expect(mock.list).toHaveBeenCalledWith(mock.ctx,{checkId:'three_way_match_exceptions',limit:1});
 await capture.handler({check_id:'three_way_match_exceptions',idempotency_key:'capture'},context);expect(mock.capture).toHaveBeenCalledWith(mock.ctx,{checkId:'three_way_match_exceptions'});
});
it('rejects caller check results and actor claims before shared mutation',async()=>{
 for(const name of ['capture_control_exceptions','assign_exception','resolve_exception']){
  const result=await tool(name).handler({check_id:'three_way_match_exceptions',person_id:'human',check_result:{status:'pass'},idempotency_key:'x'},context);expect(result.isError).toBe(true);
 }
 expect(mock.capture).not.toHaveBeenCalled();expect(mock.resolve).not.toHaveBeenCalled();
});
it('checks current owned transition authority before cached write replay',async()=>{
 const assign=tool('assign_exception');expect(assign.perUserIdempotency).toBe(true);expect(tool('resolve_exception').perUserIdempotency).toBe(true);
 mock.authorize.mockRejectedValue(new Error('current domain revoked'));
 await expect(assign.authorize!({exception_id:id,expected_version:1,owner_person_id:'owner',due_at:null,idempotency_key:'same'},context)).rejects.toThrow('current domain revoked');
 expect(mock.authorize).toHaveBeenCalledWith(mock.ctx,id);expect(mock.assign).not.toHaveBeenCalled();
});
it('passes independent human and recheck decisions only to the shared resolver',async()=>{
 mock.resolve.mockRejectedValue(new Error('Independent permitted human reviewer required'));
 await expect(tool('resolve_exception').handler({exception_id:id,expected_version:1,resolution:'fixed',reason:'Synthetic',idempotency_key:'fix'},context)).rejects.toThrow('Independent');
 expect(mock.resolve).toHaveBeenCalledWith(mock.ctx,{exceptionId:id,expectedVersion:1,resolution:'fixed',reason:'Synthetic'});
});
