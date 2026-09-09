import {expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {createAuditJobPoller} from '@/modules/accounting/services/controls/auditJobPoller';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
vi.mock('@/modules/accounting/services/controls/auditJobRunner',()=>({runAuditJob:vi.fn(async()=>({state:'not_claimed'}))}));
const company='11111111-1111-4111-8111-111111111111',job='22222222-2222-4222-8222-222222222222';
function fixture(){
 const release=vi.fn(),query=vi.fn(async(text:string)=>({rows:text.includes('SELECT j.job_id')?[{jobId:job,personId:'maker',updatedAt:'2026-09-09 12:00:00+00'}]:[]}));
 const pool={connect:vi.fn(async()=>({query,release} as unknown as PoolClient))} as unknown as Pool;
 return{pool,release};
}
it('requires an explicit execution boundary before acquiring a queue connection',()=>{
 const {pool}=fixture();expect(()=>createAuditJobPoller({companyIds:[company]},{pool} as Parameters<typeof createAuditJobPoller>[1])).toThrow('execution boundary');
 expect(pool.connect).not.toHaveBeenCalled();
});
it('passes only candidate identity and cancellation to the configured executor after releasing discovery',async()=>{
 const {pool,release}=fixture(),controller=new AbortController();
 const executeJob=vi.fn(async()=>{expect(release).toHaveBeenCalledOnce();return{state:'not_claimed' as const};});
 const result=await createAuditJobPoller({companyIds:[company]},{pool,executeJob}).pollOnce(controller.signal);
 expect(executeJob).toHaveBeenCalledExactlyOnceWith({companyId:company,personId:'maker',jobId:job},{signal:controller.signal});
 expect(result.results).toEqual([{state:'not_claimed'}]);expect(runAuditJob).not.toHaveBeenCalled();
});
it('records a failed observation when isolation is unavailable without falling back inline',async()=>{
 vi.mocked(runAuditJob).mockClear();const {pool}=fixture();
 const executeJob=vi.fn(async()=>{throw new Error('No delegated memory controller');});
 expect((await createAuditJobPoller({companyIds:[company]},{pool,executeJob}).pollOnce()).results).toEqual([{state:'failed',code:'WORKER_ERROR',failureRecorded:false}]);
 expect(runAuditJob).not.toHaveBeenCalled();
});
