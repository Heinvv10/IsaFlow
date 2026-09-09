import { expect,it,vi } from 'vitest';
vi.mock('@/lib/mcp/currentToolAuthority',()=>({assertCurrentToolAuthority:vi.fn(async()=>undefined)}));
vi.mock('@/lib/mcp/audit',()=>({ hashArgs:()=> 'hash',recordToolCall:vi.fn(),acquireIdempotencyLock:vi.fn(),findIdempotentReplay:vi.fn() }));
import { McpRegistry } from '@/lib/mcp/registry';
const ctx={userId:'user',companyId:'company',tokenJti:'grant',oauthAppId:null,scopes:['read:reports']};
it.each([null,{count:'invalid'},{count:1,dry_run:true}])('rejects invalid input before the handler: %j',async args=>{
  const handler=vi.fn(),registry=new McpRegistry();
  registry.register({name:'read_count',description:'fixture',scope:'read:reports',write:false,
    inputSchema:{type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false},handler});
  const result=await registry.call('read_count',args as unknown as Record<string,unknown>,ctx);
  expect(result.isError).toBe(true);expect(handler).not.toHaveBeenCalled();
});
