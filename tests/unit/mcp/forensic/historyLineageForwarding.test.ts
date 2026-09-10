import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({read:vi.fn(async()=>({available:true})),ctx:{principal:{companyId:'00000000-0000-4000-8000-000000000001'}}}));
vi.mock('@/modules/accounting/services/controls/controlChangeHistoryService',()=>({readControlEntityHistory:mocks.read}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>mocks.ctx}));
import {forensicHistoryTools} from '@/lib/mcp/tools/forensicHistory';
import type {McpToolContext} from '@/lib/mcp/types';
const id='abcdefab-cdef-4abc-8def-abcdefabcdef';
it('the history tool forwards the named lineage to the history read',async()=>{
 const tool=forensicHistoryTools.find(row=>row.name==='entity_change_history')!;
 await tool.handler({entity_type:'bank_transaction',entity_id:id,lineage:id.toUpperCase(),limit:5},{} as McpToolContext);
 expect(mocks.read).toHaveBeenCalledWith(mocks.ctx,{entityType:'bank_transaction',entityId:id,lineage:id.toUpperCase(),limit:5});
});
it('the history tool declares the lineage argument in its input schema',()=>{
 const tool=forensicHistoryTools.find(row=>row.name==='entity_change_history')!;
 expect((tool.inputSchema as {properties:Record<string,unknown>}).properties.lineage).toEqual({type:'string',minLength:1,maxLength:80});
});
