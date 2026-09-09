import {it,expect,vi} from 'vitest';
const coverage={status:'partial',unresolvedPaymentCount:1,unresolvedAllocationCount:1,reasons:['Missing application date'],
 population:{sourceCount:1,analyzedCount:1,recognizedRemainderCount:0,fullyAppliedCount:0,inactiveCount:0,unresolvedCount:1}};
const result={rows:[],rowsTotal:0,unattributed:[],totalUnapplied:'0',totalUnattributed:'0',postedThrough:'2026-09-09T00:00:00.000Z',historyCoverage:coverage};
vi.mock('@/modules/accounting/services/ar/unappliedReceiptService',()=>({getUnappliedReceipts:vi.fn(async()=>result)}));
vi.mock('@/modules/accounting/services/ap/unappliedPaymentService',()=>({getUnappliedPayments:vi.fn(async()=>result)}));
vi.mock('@/modules/accounting/services/ar/unappliedReceiptOrigin',()=>({getUnappliedReceiptOrigins:vi.fn(async()=>({agent:0,system:0,notStampedAsAgent:0,noJournal:0,total:0,agentTools:[],caveat:'Synthetic provenance'}))}));
import {listUnappliedReceiptsTool} from '@/lib/mcp/tools/receipts';
import {listUnappliedPaymentsTool} from '@/lib/mcp/tools/supplierPayments';
const ctx={userId:'synthetic',companyId:'11111111-1111-4111-8111-111111111111',tokenJti:'synthetic',oauthAppId:null,scopes:['read:invoices']};
it.each([listUnappliedReceiptsTool,listUnappliedPaymentsTool])('preserves unresolved cash and independent census in $name',async tool=>{
 const response=await tool.handler({as_at:'2026-09-09'},ctx),body=JSON.parse(response.content[0]!.text);
 expect(body.historyCoverage).toEqual(coverage);expect(body.universeTotal).toBeUndefined();
 expect(body.rowsTotal).toBe(0);
});
