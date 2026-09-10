import {afterEach,expect,it,vi} from 'vitest';
import {AUDIT_JOB_KINDS,AUDIT_WORKER_CLASSES,AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import {AUDIT_CHECK_RUN_IDS,AUDIT_CHECK_RUN_LIMITS} from '@/modules/accounting/services/controls/auditCheckRunContract';
import {AUDIT_PROCESS_LIMITS} from '@/modules/accounting/services/controls/auditJobProcessContract';
import {AUDIT_PROCESS_ENV,AUDIT_WORKER_CLASS_ENV,auditProcessArguments,auditResultPermittedForClass,decodeAuditProcessReply,encodeAuditProcessReply}
 from '@/modules/accounting/services/controls/auditJobProcessProtocol';
import {auditUnitCapsMatch,auditUnitObjectPath,parseBusctlUint64,parseSystemdTimeSpan} from '@/modules/accounting/services/controls/auditJobSystemd';
afterEach(()=>vi.unstubAllEnvs());
const unit='isaflow-audit-11111111-1111-4111-8111-111111111111.service',config={nodePath:'/usr/bin/node',entryPath:'/opt/isaflow/audit-job.cjs'};
const id='22222222-2222-4222-8222-222222222222',hash='a'.repeat(64);
it('partitions every job kind into exactly one worker class',()=>{
 expect(AUDIT_WORKER_CLASSES).toEqual(['audit','check_run']);
 expect(AUDIT_WORKER_CLASS_KINDS).toEqual({audit:['audit_snapshot','audit_export','audit_compare'],check_run:['audit_check_run']});
 expect([...AUDIT_WORKER_CLASS_KINDS.audit,...AUDIT_WORKER_CLASS_KINDS.check_run].sort()).toEqual([...AUDIT_JOB_KINDS].sort());
});
it('keeps the legacy class unchanged and orders the check-run timers inside the unit and the lease',()=>{
 expect(AUDIT_PROCESS_LIMITS.audit).toEqual({workDeadlineMs:60000,claimDeadlineMs:5000,unknownPublicationMs:0,failureRecordMs:5000,maxRuntimeMs:65000,killGraceMs:2000,
  runtimeMaxSec:65,memoryMaxBytes:8*1024**3,maxOldSpaceMb:4096,idleInTransactionMs:null});
 const c=AUDIT_PROCESS_LIMITS.check_run;
 expect(c).toEqual({workDeadlineMs:300000,claimDeadlineMs:5000,unknownPublicationMs:10000,failureRecordMs:5000,maxRuntimeMs:325000,killGraceMs:2000,
  runtimeMaxSec:340,memoryMaxBytes:2*1024**3,maxOldSpaceMb:1536,idleInTransactionMs:15000});
 const inner=c.claimDeadlineMs+c.workDeadlineMs+c.unknownPublicationMs+c.failureRecordMs;
 expect(inner).toBe(320000);expect(inner).toBeLessThan(c.maxRuntimeMs);
 expect(c.maxRuntimeMs).toBeLessThanOrEqual(c.runtimeMaxSec*1000-c.killGraceMs);
 for(const check of AUDIT_CHECK_RUN_IDS){const l=AUDIT_CHECK_RUN_LIMITS[check];
  expect(l.maxRuntimeMs).toBeLessThanOrEqual(c.workDeadlineMs);expect(l.maxRuntimeMs+l.graceMs).toBeGreaterThanOrEqual(inner);
  expect(l.idleMs).toBe(c.idleInTransactionMs);}
 expect(c.maxOldSpaceMb*1024*1024).toBeLessThan(c.memoryMaxBytes);
});
it('derives unit caps and heap from the class and pins the class as a literal the parent environment cannot supply',()=>{
 vi.stubEnv(AUDIT_WORKER_CLASS_ENV,'check_run');
 const audit=auditProcessArguments({...config,workerClass:'audit'},unit),check=auditProcessArguments({...config,workerClass:'check_run'},unit);
 for(const value of ['--property=MemoryMax=8589934592','--property=RuntimeMaxSec=65s','--max-old-space-size=4096','--setenv=ISAFLOW_AUDIT_WORKER_CLASS=audit'])expect(audit).toContain(value);
 for(const value of ['--property=MemoryMax=2147483648','--property=RuntimeMaxSec=340s','--max-old-space-size=1536','--setenv=ISAFLOW_AUDIT_WORKER_CLASS=check_run'])expect(check).toContain(value);
 expect(audit.filter(arg=>arg.includes(AUDIT_WORKER_CLASS_ENV))).toEqual(['--setenv=ISAFLOW_AUDIT_WORKER_CLASS=audit']);
 expect(AUDIT_PROCESS_ENV).not.toContain(AUDIT_WORKER_CLASS_ENV);
 expect(()=>auditProcessArguments({...config,workerClass:'admin'} as never,unit)).toThrow();
 expect(()=>auditProcessArguments(config as never,unit)).toThrow();
});
it('round-trips the check-run reply variant and rejects malformed replies',()=>{
 const reply={version:1 as const,result:{state:'succeeded' as const,checkRunId:id,canonicalHash:hash}};
 expect(decodeAuditProcessReply(encodeAuditProcessReply(reply))).toEqual(reply);
 for(const result of [{state:'succeeded',checkRunId:'not-a-uuid',canonicalHash:hash},{state:'succeeded',checkRunId:id,canonicalHash:'z'},
  {state:'succeeded',checkRunId:id,snapshotId:id,canonicalHash:hash},{state:'succeeded',checkRunId:id,canonicalHash:hash,findings:[]},{state:'succeeded',checkRunId:id}])
  expect(()=>decodeAuditProcessReply(Buffer.from(JSON.stringify({version:1,result})+'\n'))).toThrow();
});
it('permits only the success variants of the configured class',()=>{
 const snapshot={state:'succeeded' as const,snapshotId:id,canonicalHash:hash},check={state:'succeeded' as const,checkRunId:id,canonicalHash:hash};
 expect(auditResultPermittedForClass(snapshot,'audit')).toBe(true);expect(auditResultPermittedForClass(check,'audit')).toBe(false);
 expect(auditResultPermittedForClass(check,'check_run')).toBe(true);expect(auditResultPermittedForClass(snapshot,'check_run')).toBe(false);
 for(const other of [{state:'succeeded' as const,exportId:id,canonicalHash:hash},{state:'succeeded' as const,comparisonId:id,canonicalHash:hash}])
  expect(auditResultPermittedForClass(other,'check_run')).toBe(false);
 for(const neutral of [{state:'not_claimed' as const},{state:'busy' as const},{state:'failed' as const,code:'WORKER_ERROR' as const,failureRecorded:false}])
  for(const workerClass of AUDIT_WORKER_CLASSES)expect(auditResultPermittedForClass(neutral,workerClass)).toBe(true);
});
it('parses the time spans this host prints for RuntimeMaxUSec',()=>{
 expect(parseSystemdTimeSpan('1min 30s')).toBe(90_000_000);expect(parseSystemdTimeSpan('5min 40s')).toBe(340_000_000);
 expect(parseSystemdTimeSpan('1min 5s')).toBe(65_000_000);expect(parseSystemdTimeSpan('45s')).toBe(45_000_000);
 expect(parseSystemdTimeSpan('2h 3min 4.500000s')).toBe(7_384_500_000);expect(parseSystemdTimeSpan('2h 3min 4.500s')).toBe(7_384_500_000);
 expect(parseSystemdTimeSpan('250ms')).toBe(250_000);expect(parseSystemdTimeSpan('1d 1us')).toBe(86_400_000_001);
 for(const text of ['infinity','','5 minutes','1min30s','-5s','1.5.5s','5x'])expect(parseSystemdTimeSpan(text)).toBeNull();
});
it('reads the raw D-Bus integer and escapes the unit object path',()=>{
 expect(parseBusctlUint64('t 340000000\n')).toBe(340_000_000);
 expect(parseBusctlUint64('t 18446744073709551615\n')).toBeNull();
 for(const text of ['s "340"','t -1','t 3.4','t 340000000 1',''])expect(parseBusctlUint64(text)).toBeNull();
 expect(auditUnitObjectPath(unit)).toBe('/org/freedesktop/systemd1/unit/isaflow_2daudit_2d11111111_2d1111_2d4111_2d8111_2d111111111111_2eservice');
 expect(()=>auditUnitObjectPath('../other.service')).toThrow();
});
it('releases identity only when runtime, memory and swap caps all equal the class limits',()=>{
 const good={runtimeMaxUSec:340_000_000,memoryMax:'2147483648',memorySwapMax:'0'};
 expect(auditUnitCapsMatch(good,AUDIT_PROCESS_LIMITS.check_run)).toBe(true);
 expect(auditUnitCapsMatch(good,AUDIT_PROCESS_LIMITS.audit)).toBe(false);
 for(const changed of [{runtimeMaxUSec:99_000_000},{runtimeMaxUSec:null},{memoryMax:'8589934592'},{memoryMax:'infinity'},{memorySwapMax:'1'},{memorySwapMax:''}])
  expect(auditUnitCapsMatch({...good,...changed},AUDIT_PROCESS_LIMITS.check_run)).toBe(false);
 expect(auditUnitCapsMatch({runtimeMaxUSec:65_000_000,memoryMax:'8589934592',memorySwapMax:'0'},AUDIT_PROCESS_LIMITS.audit)).toBe(true);
});
