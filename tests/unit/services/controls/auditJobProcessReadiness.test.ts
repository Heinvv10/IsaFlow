import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {auditSystemctl,readAuditUnitCaps} from '@/modules/accounting/services/controls/auditJobSystemd';
import {createIsolatedAuditJobRunner} from '@/modules/accounting/services/controls/auditJobProcess';
vi.mock('node:child_process',async original=>({...await original<typeof import('node:child_process')>(),spawn:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/auditJobSystemd',async original=>({...await original<typeof import('@/modules/accounting/services/controls/auditJobSystemd')>(),
 auditSystemctl:vi.fn(),readAuditUnitCaps:vi.fn(),sampleAuditUnitRss:vi.fn(async()=>null),validateAuditProcessReadiness:vi.fn(async()=>({ready:true}))}));
const identity={companyId:'11111111-1111-4111-8111-111111111111',personId:'synthetic',jobId:'22222222-2222-4222-8222-222222222222'};
let child:EventEmitter&{stdin:EventEmitter&{write:ReturnType<typeof vi.fn>;end:()=>void;destroy:()=>void};stdout:EventEmitter;stderr:EventEmitter;kill:()=>void};
function close(){setImmediate(()=>child.emit('close',0,null));}
beforeEach(()=>{
 vi.stubEnv('ISAFLOW_AUDIT_WORKER_DATABASE_URL','postgres://synthetic');
 child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>close(),
  stdin:Object.assign(new EventEmitter(),{write:vi.fn(()=>{setImmediate(()=>child.stdout.emit('data',Buffer.from('{"version":1,"result":{"state":"not_claimed"}}\n')));return true;}),end:()=>close(),destroy:()=>undefined})});
 vi.mocked(spawn).mockReset().mockReturnValue(child as never);
 vi.mocked(auditSystemctl).mockReset().mockImplementation(async args=>{if(args[0]==='kill')close();return '';});
});
afterEach(()=>vi.unstubAllEnvs());
const caps=(runtimeMaxUSec:number)=>({runtimeMaxUSec,memoryMax:'2147483648',memorySwapMax:'0',properties:{LoadState:'loaded',MainPID:'42',MemoryMax:'2147483648',MemorySwapMax:'0'}});
it('releases the identity once the unit reports the class runtime and memory caps',async()=>{
 vi.mocked(readAuditUnitCaps).mockResolvedValue(caps(340_000_000));
 const value=await createIsolatedAuditJobRunner({nodePath:'/usr/bin/node',entryPath:'/opt/isaflow/audit-job.cjs',workerClass:'check_run'}).runIsolatedAuditJob(identity);
 expect(child.stdin.write).toHaveBeenCalledOnce();expect(value.result).toEqual({state:'not_claimed'});
});
it('terminates a unit whose RuntimeMaxUSec differs from the class without writing the identity',async()=>{
 vi.mocked(readAuditUnitCaps).mockResolvedValue(caps(65_000_000));
 const value=await createIsolatedAuditJobRunner({nodePath:'/usr/bin/node',entryPath:'/opt/isaflow/audit-job.cjs',workerClass:'check_run'}).runIsolatedAuditJob(identity);
 expect(child.stdin.write).not.toHaveBeenCalled();expect(value.result).toEqual({state:'failed',code:'WORKER_ERROR',failureRecorded:false});
 expect(vi.mocked(auditSystemctl).mock.calls.some(([args])=>args[0]==='kill')).toBe(true);
},10000);
it('refuses a factory configuration without a known worker class',()=>{
 for(const workerClass of [undefined,'admin'])expect(()=>createIsolatedAuditJobRunner({nodePath:'/usr/bin/node',entryPath:'/opt/isaflow/audit-job.cjs',workerClass} as never)).toThrow(/worker class/);
});
