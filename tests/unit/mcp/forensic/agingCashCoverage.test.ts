import {it,expect,vi} from 'vitest';
const coverage={status:'partial',unresolvedPaymentCount:1,unresolvedAllocationCount:1,reasons:['Missing application date'],
 population:{sourceCount:2,analyzedCount:2,recognizedRemainderCount:1,fullyAppliedCount:0,inactiveCount:0,unresolvedCount:1}};
const cash={rows:[],rowsTotal:1,unattributed:[],totalUnapplied:115,totalUnattributed:0,historyCoverage:coverage};
vi.mock('@/modules/accounting/services/ar/arAgingService',()=>({getARAging:vi.fn(async()=>[]),getARAgingDetail:vi.fn()}));
vi.mock('@/modules/accounting/services/ap/apAgingService',()=>({getAPAging:vi.fn(async()=>[]),getAPAgingDetail:vi.fn()}));
vi.mock('@/modules/accounting/services/ar/unappliedReceiptService',()=>({getUnappliedReceipts:vi.fn(async()=>cash)}));
vi.mock('@/modules/accounting/services/ap/unappliedPaymentService',()=>({getUnappliedPayments:vi.fn(async()=>cash)}));
vi.mock('@/modules/accounting/services/reports/postedThroughService',()=>({getLedgerPostedThrough:vi.fn(async()=>null)}));
import {agedDebtorsTool,agedCreditorsTool} from '@/lib/mcp/tools/reportsAging';
const ctx={userId:'synthetic',companyId:'11111111-1111-4111-8111-111111111111',tokenJti:'synthetic',oauthAppId:null,scopes:['read:reports']};
it.each([
 {tool:agedDebtorsTool,key:'unappliedReceipts'},
 {tool:agedCreditorsTool,key:'unappliedPayments'},
])('discloses unresolved history beside the recognized cash total in $key',async({tool,key})=>{
 const response=await tool.handler({as_at:'2026-09-09'},ctx),body=JSON.parse(response.content[0]!.text);
 expect(body[key].historyCoverage).toEqual(coverage);
 expect(body[key]).toMatchObject({count:1,total:115});
 expect(body.total).toBe(0); // Cash remains separately disclosed, never netted into invoice aging.
});
