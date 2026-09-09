import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ authority:vi.fn(),replay:vi.fn(),audit:vi.fn(),debit:vi.fn(),lock:vi.fn() }));
vi.mock('@/lib/mcp/currentToolAuthority', () => ({ assertCurrentToolAuthority:mock.authority }));
vi.mock('@/lib/mcp/audit', () => ({ hashArgs:()=> 'hash',recordToolCall:mock.audit,
  acquireIdempotencyLock:mock.lock,findIdempotentReplay:mock.replay }));
vi.mock('@/lib/mcp/flowMetering', () => ({ debitForTool:mock.debit,refundForTool:vi.fn() }));
vi.mock('@/lib/neon', () => ({ withSavepoint:async (_:string,fn:()=>unknown)=>fn() }));
import { McpRegistry } from '@/lib/mcp/registry';
const ctx = {userId:'person',companyId:'company',tokenJti:'grant',oauthAppId:null,scopes:['write:invoices']};
beforeEach(() => {
  vi.clearAllMocks();mock.authority.mockRejectedValue(new Error('revoked role'));
  mock.replay.mockResolvedValue({status:'match',result:{content:[{type:'text',text:'stored'}]}});
});
it('refuses a revoked principal before replay, metering or handler execution', async () => {
  const handler=vi.fn(),registry=new McpRegistry();
  registry.register({name:'controlled',scope:'write:invoices',write:true,description:'controlled',
    inputSchema:{type:'object',properties:{idempotency_key:{type:'string'}},additionalProperties:false},handler});
  const result=await registry.call('controlled',{idempotency_key:'same-intent'},ctx);
  expect(result.isError).toBe(true);expect(mock.authority).toHaveBeenCalledOnce();
  expect(mock.replay).not.toHaveBeenCalled();expect(mock.lock).not.toHaveBeenCalled();
  expect(mock.debit).not.toHaveBeenCalled();expect(handler).not.toHaveBeenCalled();
  expect(mock.audit).toHaveBeenCalledWith(expect.objectContaining({status:'rejected'}));
  expect(JSON.stringify(result)).not.toContain('revoked role');
});
