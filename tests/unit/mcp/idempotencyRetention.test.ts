import {beforeEach,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({sql:vi.fn()}));
vi.mock('@/lib/neon',()=>({sql:fixture.sql}));
import {findIdempotentReplay,recordToolCall} from '@/lib/mcp/audit';
beforeEach(()=>{fixture.sql.mockReset();fixture.sql.mockResolvedValue([]);});
it('replays from the durable effect store after invocation history is pruned',async()=>{
  const result={content:[{type:'text',text:'created'}]};
  fixture.sql.mockImplementation(async(parts:TemplateStringsArray)=>parts.join('').includes('FROM mcp_idempotency_results')
    ?[{args_hash:'hash',result}]:[]);
  expect(await findIdempotentReplay('11111111-1111-4111-8111-111111111111','create','key','hash'))
    .toEqual({status:'match',result});
});
it('persists successful keyed effects separately and excludes payload/key from invocation audit',async()=>{
  fixture.sql.mockImplementation(async(parts:TemplateStringsArray)=>parts.join('').includes('INSERT INTO mcp_idempotency_results')?[{args_hash:'hash'}]:[]);
  await recordToolCall({ctx:{companyId:'11111111-1111-4111-8111-111111111111',userId:'person',tokenJti:'grant',oauthAppId:null,scopes:[]},
    tool:'create',argsHash:'hash',idempotencyKey:'key',status:'ok',result:{content:[]},durationMs:1});
  const calls=fixture.sql.mock.calls;
  expect(calls.some(call=>call[0].join('').includes('INSERT INTO mcp_idempotency_results'))).toBe(true);
  const audit=calls.find(call=>call[0].join('').includes('INSERT INTO mcp_tool_calls'))!;
  expect(audit.slice(1)).not.toContain('key');
  expect(audit.slice(1)).not.toContain('{"content":[]}');
});
