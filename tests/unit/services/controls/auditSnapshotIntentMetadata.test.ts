import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({assert:vi.fn(),permission:vi.fn(),open:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:mocks.assert}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/auditJobProtection',()=>({openAuditJobRequest:mocks.open}));
import {readAuditSnapshotIntentMetadata} from '@/modules/accounting/services/controls/auditSnapshotIntentMetadata';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const snapshotId='11111111-1111-4111-8111-111111111111',companyId='22222222-2222-4222-8222-222222222222';
const sql=vi.fn(),ctx={principal:{companyId},sql} as unknown as ControlTx;
const row={snapshot_id:snapshotId,id:snapshotId,company_id:companyId,kind:'audit_snapshot',request_hash:'a'.repeat(64),protected_request:{version:1,keyId:'current',ciphertext:'opaque'}};
beforeEach(()=>{vi.resetAllMocks();mocks.open.mockReturnValue({kind:'audit_snapshot',request:{sources:['journals','payroll'],checks:[],cutoff:'2026-09-09',idempotencyKey:'fixture'}});});
it('returns only an authenticated original request anchor and scopes the SQL byte bound before payload transfer',async()=>{
 sql.mockResolvedValueOnce([row]);expect(await readAuditSnapshotIntentMetadata(ctx,snapshotId)).toEqual({snapshotId,sourceJobId:snapshotId,sourceRequestHash:row.request_hash,permissions:['read:payroll','read:reports']});
 const query=sql.mock.calls[0]![0].join(' ');expect(query).toMatch(/CASE WHEN octet_length/);expect(query).toContain('65536');expect(query).not.toMatch(/protected_snapshot|artifact/);expect(query).toContain("j.state='succeeded'");expect(sql.mock.calls[0]).toContain(companyId);
 expect(mocks.permission.mock.calls).toEqual([[ctx,'read:reports'],[ctx,'read:payroll'],[ctx,'read:reports']]);
});
it('refuses missing, oversized, wrong-kind and mismatched owned metadata',async()=>{
 for(const value of [[],[{...row,protected_request:null}],[{...row,company_id:snapshotId}],[{...row,snapshot_id:companyId}]]){sql.mockResolvedValueOnce(value);await expect(readAuditSnapshotIntentMetadata(ctx,snapshotId)).rejects.toThrow();}
 sql.mockResolvedValueOnce([row]);mocks.open.mockReturnValueOnce({kind:'audit_export'});await expect(readAuditSnapshotIntentMetadata(ctx,snapshotId)).rejects.toThrow(/kind/);
});
it('preserves authentication and current authority errors, rejecting invalid identities before SQL',async()=>{
 await expect(readAuditSnapshotIntentMetadata(ctx,'invalid')).rejects.toThrow();expect(sql).not.toHaveBeenCalled();
 sql.mockResolvedValueOnce([row]);mocks.open.mockImplementationOnce(()=>{throw new Error('Bad authentication');});await expect(readAuditSnapshotIntentMetadata(ctx,snapshotId)).rejects.toThrow('Bad authentication');
 mocks.permission.mockRejectedValueOnce(new Error('Current read denied'));await expect(readAuditSnapshotIntentMetadata(ctx,snapshotId)).rejects.toThrow('Current read denied');expect(sql).toHaveBeenCalledTimes(1);
});
