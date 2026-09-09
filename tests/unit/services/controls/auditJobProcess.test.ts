import {afterEach,expect,it,vi} from 'vitest';
afterEach(()=>vi.unstubAllEnvs());
import {encodeAuditProcessRequest,decodeAuditProcessReply,auditProcessArguments} from '@/modules/accounting/services/controls/auditJobProcessProtocol';
const request={version:1 as const,companyId:'11111111-1111-4111-8111-111111111111',personId:'person',jobId:'22222222-2222-4222-8222-222222222222'};
it('rejects principal, source and limit injection before spawning',()=>{
 for(const extra of [{principal:{}},{sources:['payroll']},{memoryMaxBytes:1}])expect(()=>encodeAuditProcessRequest({...request,...extra})).toThrow();
 expect(JSON.parse(encodeAuditProcessRequest(request).toString())).toEqual(request);
});
it('accepts only one bounded strict reply and no raw diagnostic fields',()=>{
 expect(decodeAuditProcessReply(Buffer.from('{"version":1,"result":{"state":"not_claimed"}}\n'))).toEqual({version:1,result:{state:'not_claimed'}});
 for(const value of ['x'.repeat(2049),'{"version":1,"result":{"state":"not_claimed","secret":"hidden"}}','{}\n{}'])expect(()=>decodeAuditProcessReply(Buffer.from(value))).toThrow();
});
it('fixes real cgroup/walltime properties and never places credentials in argv',()=>{
 vi.stubEnv('ISAFLOW_AUDIT_WORKER_DATABASE_URL','postgres://fixture');vi.stubEnv('PGPASSWORD','synthetic-secret');vi.stubEnv('CONTROL_ENCRYPTION_KEY_ID','fixture-key');
 const args=auditProcessArguments({nodePath:'/usr/bin/node',entryPath:'/opt/isaflow/audit-job.cjs'},'isaflow-audit-11111111-1111-4111-8111-111111111111.service');
 for(const required of ['--property=MemoryMax=8589934592','--property=MemorySwapMax=0','--property=RuntimeMaxSec=65s','--property=TimeoutStopSec=2s','--property=KillMode=control-group'])expect(args).toContain(required);
 expect(args).toContain('--setenv=ISAFLOW_AUDIT_WORKER_DATABASE_URL');expect(args).toContain('--setenv=PGPASSWORD');expect(args).toContain('--setenv=CONTROL_ENCRYPTION_KEY_ID');expect(args.join(' ')).not.toMatch(/postgres:|password=/);
});

it('preserves absent optional key identifiers instead of converting them to empty strings',()=>{
 vi.stubEnv('CONTROL_ENCRYPTION_KEY_ID',undefined);vi.stubEnv('CONTROL_SNAPSHOT_KEY_ID',undefined);
 const args=auditProcessArguments({nodePath:'/usr/bin/node',entryPath:'/opt/isaflow/audit-job.cjs'},'isaflow-audit-11111111-1111-4111-8111-111111111111.service');
 expect(args).not.toContain('--setenv=CONTROL_ENCRYPTION_KEY_ID');expect(args).not.toContain('--setenv=CONTROL_SNAPSHOT_KEY_ID');
});
