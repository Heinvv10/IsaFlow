import { beforeEach,expect,it,vi } from 'vitest';
import type { PoolClient } from 'pg';
import { inspectTransactionEvidence } from '@/modules/accounting/services/controls/transactionEvidenceService';
import { requireControlTx,withControlRequest } from '@/modules/accounting/services/controls/context';
const mocks=vi.hoisted(()=>({loadNode:vi.fn(),neighbors:vi.fn(),resolve:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/transactionEvidenceQueries',()=>({loadEvidenceNode:mocks.loadNode,listEvidenceNeighbors:mocks.neighbors}));
vi.mock('@/lib/auth/effectivePermissions',()=>({resolveEffectivePermissions:mocks.resolve}));
const id='11111111-1111-4111-8111-111111111111',invoice='22222222-2222-4222-8222-222222222222',doc='33333333-3333-4333-8333-333333333333';
const root={entityType:'bank_transaction' as const,entityId:id};
const client={query:vi.fn().mockResolvedValue({rows:[]})} as unknown as PoolClient;
function run(input:{entityType:string;entityId:string;limit?:number;cursor?:string}){
 return withControlRequest({client,userId:'u1',companyId:'tenant-a',claims:{}},{personId:'u1',companyId:'tenant-a',authMethod:'cookie'},
  ()=>inspectTransactionEvidence(requireControlTx(),input));
}
beforeEach(()=>{
 vi.clearAllMocks();mocks.resolve.mockResolvedValue({permissions:['read:contacts','read:invoices','read:bank-tx','read:reports','read:approvals']});
 mocks.loadNode.mockImplementation(async(_ctx,ref)=>({...ref,status:'posted',version:null,recordedSince:null,hashAvailability:'missing',flags:['untracked']}));
 mocks.neighbors.mockImplementation(async(_ctx,ref)=>({total:ref.entityId===id?1:ref.entityId===invoice?1:0,
  links:ref.entityId===id?[{target:{entityType:'supplier_invoice',entityId:invoice},relation:'payment_allocation'}]
   :ref.entityId===invoice?[{target:{entityType:'captured_document',entityId:doc},relation:'captured_invoice'}]:[]}));
});
it('traverses persisted invoice evidence from a bank root and labels historical gaps',async()=>{
 const result=await run(root);
 expect(result.nodes.map(n=>n.entityId)).toContain(doc);
 expect(result.coverage.documentCounts.captured).toBe(1);
 expect(result.coverage.historicalCoverage).toBe('untracked');
 expect(result.edges).toHaveLength(2);
});
it('missing and unauthorized roots share a generic nondisclosing refusal',async()=>{
 mocks.loadNode.mockResolvedValue(null);
 await expect(run(root)).rejects.toThrow('Evidence unavailable');
 mocks.resolve.mockResolvedValue({permissions:[]});
 await expect(run(root)).rejects.toThrow('Evidence unavailable');
});
it('omits inaccessible neighbor IDs and never claims the unseen graph is complete',async()=>{
 mocks.loadNode.mockImplementation(async(_ctx,ref)=>ref.entityId===invoice?null:{...root,status:'posted',version:null,recordedSince:null,hashAvailability:'missing',flags:['untracked']});
 const result=await run(root);expect(JSON.stringify(result)).not.toContain(invoice);
 expect(result.coverage.status).toBe('partial');expect(result.coverage.gaps.some(g=>g.reason==='MISSING_OR_INACCESSIBLE_LINK')).toBe(true);
});
it('deterministic bounded pages bind cursor to root, tenant and current graph digest',async()=>{
 const first=await run({...root,limit:1});expect(first.nodes).toHaveLength(1);expect(first.nextCursor).toBeTruthy();
 const second=await run({...root,limit:1,cursor:first.nextCursor!});expect(second.nodes[0]!.entityId).not.toBe(first.nodes[0]!.entityId);
 await expect(run({...root,entityId:doc,cursor:first.nextCursor!})).rejects.toThrow('cursor');
});
it('refuses oversized pages and forged transaction contexts',async()=>{
 await expect(run({...root,limit:101})).rejects.toThrow();
 await expect(inspectTransactionEvidence({sql:vi.fn(),principal:{}} as never,root)).rejects.toThrow();
});
it('caps large reachable populations at 500 nodes with explicit partial visited counts',async()=>{
 const refs=Array.from({length:510},(_,i)=>({entityType:'bank_attachment' as const,entityId:`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12,'0')}`}));
 mocks.neighbors.mockImplementation(async(_ctx,ref,offset,limit)=>ref.entityId===id
  ?{total:refs.length,links:refs.slice(offset,offset+limit).map(target=>({target,relation:'bank_attachment'}))}:{total:0,links:[]});
 const result=await run({...root,limit:100});expect(result.coverage.visitedNodes).toBe(500);expect(result.nodes).toHaveLength(100);
 expect(result.coverage.documentCounts.bank_attachment).toBe(499);expect(result.coverage.status).toBe('partial');
 expect(result.coverage.gaps.some(g=>g.reason==='NODE_BUDGET')).toBe(true);
});
it('malformed or unsupported persisted references cannot become queries or exposed identifiers',async()=>{
 mocks.neighbors.mockResolvedValue({total:1,links:[{target:{entityType:'employee',entityId:'protected-payroll-identifier'},relation:'approval_subject'}]});
 const result=await run(root);expect(JSON.stringify(result)).not.toContain('protected-payroll');expect(mocks.loadNode).toHaveBeenCalledTimes(1);
 expect(result.coverage.status).toBe('partial');
});
it('reports invalid recorded approval evidence without traversing or exposing the rejected document',async()=>{
 mocks.neighbors.mockResolvedValue({total:1,links:[{target:{entityType:'captured_document',entityId:doc},relation:'approval_evidence',gap:'APPROVAL_EVIDENCE_PARENT_UNVERIFIED'}]});
 const result=await run(root);expect(JSON.stringify(result)).not.toContain(doc);expect(mocks.loadNode).toHaveBeenCalledTimes(1);
 expect(result.coverage.gaps.some(g=>g.reason==='APPROVAL_EVIDENCE_PARENT_UNVERIFIED')).toBe(true);
});
