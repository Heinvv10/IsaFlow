import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({ctx:{principal:{personId:'person'}},permission:vi.fn(),requirements:vi.fn(),request:vi.fn(),list:vi.fn(),requester:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>m.ctx}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:m.permission}));
vi.mock('@/modules/accounting/services/controls/approvalRequestService',()=>({getApprovalRequirements:m.requirements,requestOperationApproval:m.request}));
vi.mock('@/modules/accounting/services/controls/approvalReadService',()=>({listOperationApprovals:m.list}));
vi.mock('@/modules/accounting/services/controls/operationRequester',()=>({assertOperationRequester:m.requester}));
import {forensicApprovalTools} from '@/lib/mcp/tools/forensicApprovals';
const id='11111111-1111-4111-8111-111111111111';
const ctx={userId:'person',companyId:id,scopes:[],tokenJti:null,oauthAppId:null};
const input={operation:'journal.reverse',entity_type:'journal_entry',entity_id:id,expected_version:2,reversal_date:'2026-09-10'};
beforeEach(()=>vi.clearAllMocks());
it('forwards exact supported date/version reference and issued context',async()=>{
 await forensicApprovalTools[0].handler(input,ctx);
 expect(m.requirements).toHaveBeenCalledWith(m.ctx,{operation:'journal.reverse',entityType:'journal_entry',entityId:id,expectedVersion:2,reversalDate:'2026-09-10'});
});
it('keeps pending filtering and signed continuation in the shared paged reader',async()=>{
 await forensicApprovalTools[2].handler({limit:17,cursor:'signed'},ctx);
 expect(m.list).toHaveBeenCalledWith(m.ctx,{status:'pending',limit:17,cursor:'signed'});
 for(const args of [{limit:101},{status:'approved'},{cursor:'x'.repeat(2049)}])expect((await forensicApprovalTools[2].handler(args,ctx)).isError).toBe(true);
});
it('requires current operation and approval rights before person-scoped replay',async()=>{
 const tool=forensicApprovalTools[1];
 expect(tool.perUserIdempotency).toBe(true);
 await tool.authorize!({...input,idempotency_key:'retry'},ctx);
 expect(m.permission.mock.calls.map(c=>c[1])).toContain('write:approvals');
 expect(m.permission.mock.calls.map(c=>c[1])).toContain('write:post');
 expect(m.requester).toHaveBeenCalled();
 m.permission.mockRejectedValueOnce(new Error('revoked'));
 await expect(tool.authorize!({...input,idempotency_key:'retry'},ctx)).rejects.toThrow('revoked');
 expect(m.request).not.toHaveBeenCalled();
});
it('refuses caller authority, accessor reads and foreign company assertions',async()=>{
 const getter=vi.fn(()=>id),args={...input};Object.defineProperty(args,'entity_id',{enumerable:true,get:getter});
 expect((await forensicApprovalTools[0].handler(args,ctx)).isError).toBe(true);expect(getter).not.toHaveBeenCalled();
 expect((await forensicApprovalTools[0].handler({...input,person_id:id},ctx)).isError).toBe(true);
 await expect(forensicApprovalTools[1].authorize!({...input,idempotency_key:'retry',company_id:'foreign'},ctx)).rejects.toThrow();
});
