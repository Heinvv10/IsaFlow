import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({begin:vi.fn(),complete:vi.fn(),handler:vi.fn(),debit:vi.fn(),replay:vi.fn(),audit:vi.fn(),authority:vi.fn(),savepoint:vi.fn(async(_name:string,fn:()=>unknown)=>fn())}));
vi.mock('@/lib/mcp/invocationStore',()=>({beginMcpInvocation:mocks.begin,completeMcpInvocation:mocks.complete}));
vi.mock('@/lib/mcp/currentToolAuthority',()=>({assertCurrentToolAuthority:mocks.authority}));
vi.mock('@/lib/neon',()=>({withSavepoint:mocks.savepoint}));
vi.mock('@/lib/logger',()=>({log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
vi.mock('@/lib/mcp/flowMetering',()=>({debitForTool:mocks.debit,refundForTool:vi.fn()}));
vi.mock('@/lib/mcp/audit',async importOriginal=>({...await importOriginal<object>(),recordToolCall:mocks.audit,
 acquireIdempotencyLock:vi.fn(),findIdempotentReplay:mocks.replay}));
import {McpRegistry} from '@/lib/mcp/registry';
const ctx={companyId:'11111111-1111-4111-8111-111111111111',userId:'u1',scopes:['write:journals','write:post'],tokenJti:'pat-original',oauthAppId:null};
const success={content:[{type:'text' as const,text:'ok'}]};
let registry:McpRegistry;
beforeEach(()=>{
 vi.clearAllMocks();mocks.begin.mockResolvedValue({attemptId:'attempt'});mocks.complete.mockResolvedValue(undefined);
 mocks.handler.mockResolvedValue(success);mocks.debit.mockResolvedValue({ok:true,handle:null});
 mocks.replay.mockResolvedValue({status:'none'});mocks.authority.mockResolvedValue(undefined);
 registry=new McpRegistry();registry.register({name:'post_journal',description:'synthetic',write:true,requiresPost:true,scope:'write:journals',
 inputSchema:{type:'object',properties:{idempotency_key:{type:'string'}},additionalProperties:false},handler:mocks.handler});
});
it('admits durable evidence before authority, debit or handler and completes after the handler',async()=>{
 await registry.call('post_journal',{idempotency_key:'private-key'},ctx);
 expect(mocks.begin).toHaveBeenCalledTimes(1);
 expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(mocks.authority.mock.invocationCallOrder[0]!);
 expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(mocks.debit.mock.invocationCallOrder[0]!);
 expect(mocks.complete.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.handler.mock.invocationCallOrder[0]!);
 expect(mocks.complete).toHaveBeenCalledWith({attemptId:'attempt'},expect.objectContaining({status:'ok',reportedWrite:true}));
 expect(JSON.stringify(mocks.begin.mock.calls)).not.toContain('private-key');
});
it('fails closed before billing or effects when admission fails',async()=>{
 mocks.begin.mockRejectedValue(new Error('evidence unavailable'));
 await expect(registry.call('post_journal',{idempotency_key:'key'},ctx)).rejects.toThrow();
 expect(mocks.debit).not.toHaveBeenCalled();expect(mocks.handler).not.toHaveBeenCalled();
});
it.each(['unknown','scope','validation','key','authority','conflict'])('records a rejected attempt for %s',async reason=>{
 if(reason==='authority')mocks.authority.mockRejectedValue(new Error('revoked'));
 if(reason==='conflict')mocks.replay.mockResolvedValue({status:'conflict'});
 const args=reason==='key'?{}:reason==='validation'?{bad:true}:{idempotency_key:'key'};
 const result=await registry.call(reason==='unknown'?'missing_tool':'post_journal',args,reason==='scope'?{...ctx,scopes:[]}:ctx);
 expect(result.isError).toBe(true);expect(mocks.handler).not.toHaveBeenCalled();
 expect(mocks.complete).toHaveBeenCalledWith({attemptId:'attempt'},expect.objectContaining({status:'rejected',reportedWrite:false}));
});
it('records replay as a new attempt without another debit or effect',async()=>{
 mocks.replay.mockResolvedValue({status:'match',result:success});
 expect(await registry.call('post_journal',{idempotency_key:'key'},ctx)).toEqual(success);
 expect(mocks.debit).not.toHaveBeenCalled();expect(mocks.handler).not.toHaveBeenCalled();
 expect(mocks.complete).toHaveBeenCalledWith({attemptId:'attempt'},expect.objectContaining({status:'replay',reportedWrite:false}));
});
it('records handler failure separately from refusal without copying its error',async()=>{
 mocks.handler.mockRejectedValue(new Error('secret SQL account number'));
 await registry.call('post_journal',{idempotency_key:'key'},ctx);
 expect(mocks.complete).toHaveBeenCalledWith({attemptId:'attempt'},expect.objectContaining({status:'error',reportedWrite:false}));
 expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain('secret');
});
it('does not convert mandatory completion failure to apparent tool success',async()=>{
 mocks.complete.mockRejectedValue(new Error('receipt failed'));
 await expect(registry.call('post_journal',{idempotency_key:'key'},ctx)).rejects.toThrow();
});

it('rolls a write-handler refusal back before recording its rejected receipt',async()=>{
 mocks.handler.mockResolvedValue({content:[{type:'text',text:'refused'}],isError:true});
 const result=await registry.call('post_journal',{idempotency_key:'key'},ctx);
 expect(result.isError).toBe(true);
 await expect(mocks.savepoint.mock.results[0]!.value).rejects.toThrow();
 expect(mocks.complete).toHaveBeenCalledWith({attemptId:'attempt'},expect.objectContaining({status:'rejected',reportedWrite:false}));
});
