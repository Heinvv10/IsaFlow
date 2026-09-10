import {expect,it,vi,beforeEach} from 'vitest';
const mock=vi.hoisted(()=>({review:vi.fn(),ctx:{principal:{companyId:'owned'}}}));
vi.mock('@/modules/accounting/services/controls/accessControlReviewService',()=>({reviewAccessControl:mock.review}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>mock.ctx}));
import {accessControlReviewTool as tool} from '@/lib/mcp/tools/forensicAccess';
import {MCP_TOOLS} from '@/lib/mcp/toolIndex';
import {CLIENT_MCP_TOOL_NAMES} from '@/lib/mcp/clientMetadata';
import {flowOperationFor} from '@/lib/mcp/flowMetering';
const context={companyId:'owned'} as never;
beforeEach(()=>{vi.clearAllMocks();mock.review.mockResolvedValue({populationTotal:7,items:[],nextCursor:null});});
it('registers the tenant access reader with its real permission and free metering',()=>{
 expect(tool).toBeDefined();expect(tool.scope).toBe('read:access');expect(tool.write).toBe(false);
 expect(MCP_TOOLS.filter(row=>row.name==='access_control_review')).toEqual([tool]);
 expect(CLIENT_MCP_TOOL_NAMES.filter(name=>name==='access_control_review')).toEqual(['access_control_review']);expect(flowOperationFor('access_control_review',{})).toBeNull();
});
it('delegates strict bounded metadata review and preserves omitted optional fields',async()=>{
 await tool.handler({kind:'oauth',limit:1,dormant_days:30},context);expect(mock.review).toHaveBeenCalledWith(mock.ctx,{kind:'oauth',limit:1,dormantDays:30});
 await tool.handler({kind:'pat'},context);expect(mock.review).toHaveBeenLastCalledWith(mock.ctx,{kind:'pat'});
});
it('refuses caller tenant, role and source-query injection before the shared reader',async()=>{
 for(const args of [{kind:'pat',company_id:'foreign'},{kind:'pat',role:'owner'},{kind:'pat',query:'SELECT'},{kind:'pat',limit:101}])expect((await tool.handler(args,context)).isError).toBe(true);
 expect(mock.review).not.toHaveBeenCalled();
});
