import {cancelAuditWorkerBackend} from '@/modules/accounting/services/controls/auditWorkerConnection';
import {afterEach,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
vi.mock('@/modules/accounting/services/controls/auditWorkerConnection',async original=>({...await original<typeof import('@/modules/accounting/services/controls/auditWorkerConnection')>(),cancelAuditWorkerBackend:vi.fn()}));
const identity={companyId:'11111111-1111-4111-8111-111111111111',personId:'synthetic-person',jobId:'22222222-2222-4222-8222-222222222222'};
afterEach(()=>vi.restoreAllMocks());
it('commits only after work and refuses a failed control audit even when work returns',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{pid:42}]}),release=vi.fn(),client={query,release} as unknown as PoolClient;
 const pool={connect:vi.fn().mockResolvedValue(client)} as unknown as Pool;
 await expect(withAuditWorkerTransaction(pool,identity,'repeatable read',Date.now()+10000,undefined,async store=>{
  store.controlWriteFailed=true;return 'not safe to commit';
 })).rejects.toThrow(/audit|integrity/i);
 expect(query.mock.calls.some(call=>call[0]==='COMMIT')).toBe(false);
 expect(query.mock.calls.some(call=>call[0]==='ROLLBACK')).toBe(true);expect(release).toHaveBeenCalledOnce();
});
it('cancels the exact active backend and waits for cancellation before releasing its connection',async()=>{
 const events:string[]=[],controller=new AbortController();
 const query=vi.fn().mockResolvedValue({rows:[{pid:42}]}),release=vi.fn(()=>events.push('release-work'));
 const pool={connect:vi.fn().mockResolvedValue({query,release})} as unknown as Pool;
 vi.mocked(cancelAuditWorkerBackend).mockImplementation(async(actual,pid)=>{expect(actual).toBe(pool);expect(pid).toBe(42);await Promise.resolve();events.push('cancel');});
 await expect(withAuditWorkerTransaction(pool,identity,'repeatable read',Date.now()+10000,controller.signal,async()=>{
  controller.abort(new Error('Synthetic cancellation'));await Promise.resolve();return 'discard';
 })).rejects.toThrow('Synthetic cancellation');
 expect(cancelAuditWorkerBackend).toHaveBeenCalledOnce();expect(pool.connect).toHaveBeenCalledOnce();expect(events.indexOf('cancel')).toBeLessThan(events.indexOf('release-work'));
 expect(query.mock.calls.some(call=>call[0]==='COMMIT')).toBe(false);
});
