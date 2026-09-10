import {afterEach,expect,it,vi} from 'vitest';
import {readRetainedAuditSnapshotSeal} from '@/modules/accounting/services/controls/auditRetainedSnapshotSeal';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {protectChangeValues} from '@/modules/accounting/services/controls/changeProtection';
import {auditRequestHash} from '@/modules/accounting/services/controls/auditJobProtection';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const guards=vi.hoisted(()=>({context:vi.fn(),permission:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:guards.context}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:guards.permission}));
const companyId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
function fixture(){
 vi.stubEnv('ENCRYPTION_KEY','synthetic-retained-seal-encryption-000000000');vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-retained-seal-signing-00000000000');
 const request={cutoff:'2026-09-09',sources:['payroll'],checks:[],idempotencyKey:'synthetic'};
 const sealed=sealAuditSnapshot({version:1,companyId,snapshotId:id,cutoff:request.cutoff,capturedAt:'2026-09-10T00:00:00.000Z',
  records:[],checks:[],evidence:[],populations:['payroll_run','payroll_run_line'].map(source=>({source,count:0,excludedCount:0,exclusions:[]})),coverage:[],missingSources:[]});
 const protected_request=protectChangeValues('audit_job',null,{companyId,jobId:id,kind:'audit_snapshot',request,
  authority:{personId:'person',authMethod:'cookie',connectionId:null,grantId:null,grantedScopes:null,actingFirmId:null},delegationExpiresAt:'2026-09-11T00:00:00.000Z'}).protectedPayload;
 const row={id,kind:'audit_snapshot',company_id:companyId,requester_person_id:'person',request_hash:auditRequestHash(request),protected_request,
  canonical_hash:sealed.canonicalHash,protected_snapshot:protectChangeValues('audit_snapshot',null,{companyId,snapshotId:id,jobId:id,sealed}).protectedPayload};
 const sql=vi.fn(async()=>[row]),ctx={principal:{companyId},sql} as unknown as ControlTx;
 return{row,sql,ctx,sealed};
}
it('authenticates retained intent and seal with current domains using one tenant-scoped query and no binary loads',async()=>{
 const f=fixture();expect(await readRetainedAuditSnapshotSeal(f.ctx,id)).toMatchObject({sealed:f.sealed});
 expect(guards.context).toHaveBeenCalledWith(f.ctx);expect(guards.permission.mock.calls.map(call=>call[1])).toEqual(['read:reports','read:payroll','read:reports']);
 expect(f.sql).toHaveBeenCalledTimes(1);
 const query=(f.sql.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?');
 expect(query).toContain("j.state='succeeded'");expect(query).toContain('s.company_id=');expect(query).not.toContain('control_audit_snapshot_artifacts');
});
it('refuses current permission revocation and retained hash or protected identity tampering',async()=>{
 const f=fixture();guards.permission.mockRejectedValueOnce(new Error('revoked'));
 await expect(readRetainedAuditSnapshotSeal(f.ctx,id)).rejects.toThrow('revoked');expect(f.sql).not.toHaveBeenCalled();
 f.row.canonical_hash='f'.repeat(64);await expect(readRetainedAuditSnapshotSeal(f.ctx,id)).rejects.toThrow(/hash/i);
 f.row.canonical_hash=f.sealed.canonicalHash;
 f.row.protected_snapshot=protectChangeValues('audit_snapshot',null,{companyId:id,snapshotId:id,jobId:id,sealed:f.sealed}).protectedPayload;
 await expect(readRetainedAuditSnapshotSeal(f.ctx,id)).rejects.toThrow(/identity/i);
});
