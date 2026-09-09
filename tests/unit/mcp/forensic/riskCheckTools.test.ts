import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({invoice:vi.fn(),payment:vi.fn(),context:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/duplicateInvoiceChecks',()=>({checkDuplicateInvoices:mocks.invoice}));
vi.mock('@/modules/accounting/services/controls/paymentRiskChecks',()=>({checkPaymentRisks:mocks.payment}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mocks.context}));
import {duplicateInvoiceChecksTool,paymentRiskChecksTool} from '@/lib/mcp/tools/forensicRiskChecks';
import {MCP_TOOLS} from '@/lib/mcp/toolIndex';
import {CLIENT_MCP_TOOL_NAMES} from '@/lib/mcp/clientMetadata';
import {flowOperationFor} from '@/lib/mcp/flowMetering';
const ctx={companyId:'transport-company',userId:'transport-person',scopes:['read:reports'],tokenJti:'token',oauthAppId:null};
const bound={principal:{companyId:'authenticated-company',personId:'authenticated-person'}};
const result={checkId:'synthetic',checkVersion:1,status:'unknown',populationCount:123,excludedCount:0,findingCount:0,
 amountTotals:{},findings:[],nextCursor:null,coverage:[],missingSources:['source_missing'],capturedAt:'2026-09-09T00:00:00Z',cutoff:null,sourceVersions:[]};
beforeEach(()=>{vi.clearAllMocks();mocks.context.mockReturnValue(bound);mocks.invoice.mockResolvedValue(result);mocks.payment.mockResolvedValue(result);});
it.each([duplicateInvoiceChecksTool,paymentRiskChecksTool])('registers $name as a free read with the current discovery contract',tool=>{
 expect(MCP_TOOLS).toContain(tool);expect(CLIENT_MCP_TOOL_NAMES).toContain(tool.name);
 expect(tool.scope).toBe('read:reports');expect(tool.write).toBe(false);expect(tool.requiresPost).toBeUndefined();
 expect(flowOperationFor(tool.name,{})).toBeNull();
});
it.each([duplicateInvoiceChecksTool,paymentRiskChecksTool])('preserves unknown coverage and complete counts for $name',async tool=>{
 const answer=await tool.handler({limit:20,cutoff:'2026-08-31'},ctx);
 expect(JSON.parse(answer.content[0]!.text)).toEqual(result);
 const checker=tool===duplicateInvoiceChecksTool?mocks.invoice:mocks.payment;
 expect(checker).toHaveBeenCalledWith(bound,{limit:20,cutoff:'2026-08-31'});
});
it.each([{limit:101},{limit:0},{limit:1.5},{cutoff:'2026-02-31'},{cursor:'x'.repeat(1025)},{company_id:'foreign'}])('refuses invalid input before shared data access',async args=>{
 const response=await duplicateInvoiceChecksTool.handler(args,ctx);expect(response.isError).toBe(true);
 expect(mocks.context).not.toHaveBeenCalled();expect(mocks.invoice).not.toHaveBeenCalled();
});
it('propagates current authority refusal from the shared service',async()=>{
 mocks.payment.mockRejectedValue(new Error('Current authority denied'));
 await expect(paymentRiskChecksTool.handler({},ctx)).rejects.toThrow('Current authority denied');
});
