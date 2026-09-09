import {beforeEach,expect,it,vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {als} from '@/lib/als';
import {createAuditJobPoller,runAuditJobPoller} from '@/modules/accounting/services/controls/auditJobPoller';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
vi.mock('@/modules/accounting/services/controls/auditJobRunner',()=>({runAuditSnapshotJob:vi.fn()}));
const company='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const job='33333333-3333-4333-8333-333333333333',query=vi.fn(),release=vi.fn();
const client={query,release} as unknown as PoolClient,pool={connect:vi.fn(async()=>client)} as unknown as Pool;
const candidate={jobId:job,personId:'synthetic-user',updatedAt:'2026-09-09 12:00:00.123456+00'};
beforeEach(()=>{
 query.mockReset().mockImplementation(async(text:string)=>({rows:text.includes('SELECT j.job_id')?[candidate]:[]}));release.mockReset();
 vi.mocked(runAuditSnapshotJob).mockReset().mockImplementation(async()=>{
  expect(als.getStore()).toBeUndefined();expect(release).toHaveBeenCalled();return{state:'not_claimed'};
 });
});
it('reads only tenant-scoped queue metadata, commits and releases before delegated execution',async()=>{
 const poller=createAuditJobPoller({companyIds:[company],batchSize:10},{pool});
 expect(await poller.pollOnce()).toMatchObject({companyId:company,attempted:1});
 expect(runAuditSnapshotJob).toHaveBeenCalledWith({companyId:company,personId:candidate.personId,jobId:job},{pool,signal:undefined});
 const call=query.mock.calls.find(([text])=>String(text).includes('SELECT j.job_id'))!;
 expect(call[0]).toContain('j.company_id=');expect(call[0]).not.toContain('protected_request');expect(call[1]).toContain(company);
 expect(query.mock.calls.map(([text])=>text)).toContain('COMMIT');
});
it('rotates configured companies and advances beyond unclaimable queued jobs',async()=>{
 const poller=createAuditJobPoller({companyIds:[company,other]},{pool});
 await poller.pollOnce();await poller.pollOnce();await poller.pollOnce();
 const calls=query.mock.calls.filter(([text])=>String(text).includes('SELECT j.job_id'));
 expect(calls[1]![1]).toContain(other);expect(calls[2]![1]).toContain(candidate.updatedAt);expect(calls[2]![1]).toContain(job);
});
it('runs candidates sequentially and passes active shutdown cancellation to the runner',async()=>{
 query.mockImplementation(async(text:string)=>({rows:text.includes('SELECT j.job_id')?[candidate,{...candidate,jobId:other}]:[]}));
 const controller=new AbortController();let active=0,maximum=0;
 vi.mocked(runAuditSnapshotJob).mockImplementation(async(_identity,options)=>{
  active++;maximum=Math.max(maximum,active);expect(options?.signal).toBe(controller.signal);
  await Promise.resolve();active--;controller.abort();return{state:'not_claimed'};
 });
 await createAuditJobPoller({companyIds:[company]},{pool}).pollOnce(controller.signal);
 expect(maximum).toBe(1);expect(runAuditSnapshotJob).toHaveBeenCalledTimes(1);
});
it('refuses HTTP/ALS invocation and invalid queue configuration',async()=>{
 expect(()=>createAuditJobPoller({companyIds:[company],batchSize:11},{pool})).toThrow();
 const poller=createAuditJobPoller({companyIds:[company]},{pool});
 await als.run({client,userId:'http-user',companyId:company,claims:{}},async()=>{
  await expect(poller.pollOnce()).rejects.toThrow(/cold|HTTP/i);
 });
 expect(runAuditSnapshotJob).not.toHaveBeenCalled();
});
it('once mode performs one scan and shutdown stops interval waiting',async()=>{
 expect(await runAuditJobPoller({companyIds:[company],once:true},{pool})).toMatchObject({polls:1});
 const controller=new AbortController();vi.mocked(runAuditSnapshotJob).mockImplementation(async()=>{controller.abort();return{state:'not_claimed'};});
 expect(await runAuditJobPoller({companyIds:[company],intervalMs:60000},{pool,signal:controller.signal})).toMatchObject({polls:1});
});
