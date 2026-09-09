import {expect,it,vi} from 'vitest';
import {getAuthPool} from '@/lib/auth/authPool';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
vi.mock('@/lib/auth/authPool',()=>({getAuthPool:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/auditWorkerTransaction',()=>({withAuditWorkerTransaction:vi.fn().mockResolvedValue(null)}));
it('does not leave the process busy after database configuration failure',async()=>{
 const identity={companyId:'11111111-1111-4111-8111-111111111111',personId:'synthetic',jobId:'22222222-2222-4222-8222-222222222222'};
 vi.mocked(getAuthPool).mockImplementationOnce(()=>{throw new Error('Database configuration missing');});
 await expect(runAuditSnapshotJob(identity)).rejects.toThrow('Database configuration missing');
 expect(await runAuditSnapshotJob(identity)).toEqual({state:'not_claimed'});
 expect(withAuditWorkerTransaction).toHaveBeenCalledOnce();
});
