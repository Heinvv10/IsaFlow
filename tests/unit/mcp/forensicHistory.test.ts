import {expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({ctx:{},history:vi.fn(),calls:vi.fn(),graph:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>m.ctx}));
vi.mock('@/modules/accounting/services/controls/controlChangeHistoryService',()=>({readControlEntityHistory:m.history}));
vi.mock('@/lib/mcp/invocationHistory',()=>({listMcpInvocations:m.calls}));
vi.mock('@/modules/accounting/services/controls/transactionEvidenceService',()=>({inspectTransactionEvidence:m.graph}));
import {forensicHistoryTools} from '@/lib/mcp/tools/forensicHistory';
const id='11111111-1111-4111-8111-111111111111',ctx={userId:'person',companyId:id,scopes:[],tokenJti:null,oauthAppId:null};
it('forwards exact bounded history and invocation continuations without reconciling',async()=>{
 await forensicHistoryTools[0].handler({entity_type:'gl_account',entity_id:id,limit:100,cursor:'signed'},ctx);
 expect(m.history).toHaveBeenCalledWith(m.ctx,{entityType:'gl_account',entityId:id,limit:100,cursor:'signed'});
 await forensicHistoryTools[1].handler({after_id:id,limit:2},ctx);expect(m.calls).toHaveBeenCalledWith(m.ctx,{afterId:id,limit:2});
 expect(forensicHistoryTools.every(tool=>!tool.write)).toBe(true);
});
it('preserves actual graph partial coverage and explicit gaps unchanged',async()=>{
 const graph={nodes:[],edges:[],coverage:{status:'partial',countScope:'visited_population',gaps:[{reason:'NODE_BUDGET'}]},nextCursor:'next'};
 m.graph.mockResolvedValue(graph);
 const result=await forensicHistoryTools[2].handler({entity_type:'supplier',entity_id:id},ctx);
 expect(JSON.parse(result.content[0]!.text!)).toEqual(graph);
});
it('rejects authority injection, huge pages and nested getters without invoking them',async()=>{
 const getter=vi.fn(()=>id),input={entity_type:'supplier',entity_id:id};Object.defineProperty(input,'entity_id',{enumerable:true,get:getter});
 expect((await forensicHistoryTools[0].handler(input,ctx)).isError).toBe(true);expect(getter).not.toHaveBeenCalled();
 for(const args of [{entity_type:'supplier',entity_id:id,company_id:id},{entity_type:'supplier',entity_id:id,limit:101}])expect((await forensicHistoryTools[0].handler(args,ctx)).isError).toBe(true);
});
