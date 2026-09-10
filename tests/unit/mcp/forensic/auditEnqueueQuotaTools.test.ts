import {beforeEach,expect,it,vi} from 'vitest';
import {AuditEnqueueQuotaError} from '@/modules/accounting/services/controls/auditEnqueueQuota';
const mocks=vi.hoisted(()=>({ctx:{issued:'fixture'},snapshot:vi.fn(),export:vi.fn(),compare:vi.fn(),checks:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>mocks.ctx}));
vi.mock('@/modules/accounting/services/controls/auditJobService',()=>({enqueueAuditSnapshot:mocks.snapshot,getAuditJob:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/auditExportJobService',()=>({enqueueAuditExport:mocks.export}));
vi.mock('@/modules/accounting/services/controls/auditComparisonJobService',()=>({enqueueAuditComparison:mocks.compare}));
vi.mock('@/modules/accounting/services/controls/auditCheckRunJobService',()=>({enqueueAuditCheckRuns:mocks.checks}));
import {auditDeliveryTools} from '@/lib/mcp/tools/auditDelivery';
import {auditCheckRunTools} from '@/lib/mcp/tools/auditCheckRuns';
/**
 * A rate refusal is an answer an agent must be able to read — "try later, and why" — not the registry's generic
 * failure, which invites the very retry loop the rate exists to stop. Every audit enqueue says which rate refused it.
 */
const id='11111111-1111-4111-8111-111111111111',ctx={userId:'user',companyId:'company',scopes:['write:audit'],tokenJti:'token',oauthAppId:null};
const CASES=[
 ['audit_snapshot',mocks.snapshot,'audit_snapshot',{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotency_key:'k'},'snapshot'],
 ['export_audit_evidence',mocks.export,'audit_export',{snapshot_id:id,idempotency_key:'k'},'export'],
 ['compare_audit_snapshots',mocks.compare,'audit_compare',{first_snapshot_id:id,second_snapshot_id:id,idempotency_key:'k'},'comparison'],
 ['run_control_checks',mocks.checks,'audit_check_run',{cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotency_key:'k'},'check-run'],
] as const;
beforeEach(()=>vi.clearAllMocks());
for(const [name,enqueue,kind,args,label] of CASES)it(`${name} answers a refused rate legibly`,async()=>{
 enqueue.mockRejectedValueOnce(new AuditEnqueueQuotaError(kind,'member'));
 const tool=[...auditDeliveryTools,...auditCheckRunTools].find(candidate=>candidate.name===name)!;
 const result=await tool.handler({...args},ctx);
 expect(result.isError,`${name} let a quota refusal escape as a handler failure`).toBe(true);
 expect(result.content.map(item=>item.text).join('\n')).toBe(`Audit ${label} quota exceeded (member)`);
});
it('still lets any other enqueue failure reach the registry as a failure',async()=>{
 mocks.snapshot.mockRejectedValueOnce(new Error('database unavailable'));
 await expect(auditDeliveryTools.find(tool=>tool.name==='audit_snapshot')!.handler({cutoff:'2026-09-09',sources:['journals'],checks:[],idempotency_key:'k'},ctx)).rejects.toThrow('database unavailable');
});
