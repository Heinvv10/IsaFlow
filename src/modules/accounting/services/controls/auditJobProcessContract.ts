import type {AuditWorkerResult} from './auditJobRunner';
import type {AuditWorkerClass} from './auditJobContract';
import {AUDIT_CHECK_RUN_LIMITS} from './auditCheckRunContract';
/** Root-owned cold process boundary. Never transfer a principal, lease or financial payload. */
export interface AuditProcessRequest {version:1;companyId:string;personId:string;jobId:string}
export interface AuditProcessReply {version:1;result:AuditWorkerResult}
export interface AuditClassLimits {
 /** Runner abort timer from process start; the work transaction ends here. */
 workDeadlineMs:number;claimDeadlineMs:number;unknownPublicationMs:number;failureRecordMs:number;
 /** Parent SIGTERM, then SIGKILL after killGraceMs; systemd RuntimeMaxSec is the outer wall. */
 maxRuntimeMs:number;killGraceMs:number;runtimeMaxSec:number;memoryMaxBytes:number;maxOldSpaceMb:number;idleInTransactionMs:number|null;
}
const journal=AUDIT_CHECK_RUN_LIMITS.journal_risk_checks;
/**
 * `audit` is unchanged. `check_run` is spike-derived (plan v6 A11):
 * claim 5 + work 300 + unknown 10 + failure 5 = 320 s < parent SIGTERM 325 s <= RuntimeMaxSec 340 - killGrace 2,
 * and the claimed lease maxRuntime + grace = 330 s >= 320 s.
 */
export const AUDIT_PROCESS_LIMITS=Object.freeze({
 maxRequestBytes:2048,maxReplyBytes:2048,maxDiagnosticBytes:8192,
 audit:Object.freeze<AuditClassLimits>({workDeadlineMs:60000,claimDeadlineMs:5000,unknownPublicationMs:0,failureRecordMs:5000,
  maxRuntimeMs:65000,killGraceMs:2000,runtimeMaxSec:65,memoryMaxBytes:8*1024*1024*1024,maxOldSpaceMb:4096,idleInTransactionMs:null}),
 check_run:Object.freeze<AuditClassLimits>({workDeadlineMs:journal.maxRuntimeMs,claimDeadlineMs:5000,unknownPublicationMs:10000,failureRecordMs:5000,
  maxRuntimeMs:325000,killGraceMs:2000,runtimeMaxSec:340,memoryMaxBytes:2*1024*1024*1024,maxOldSpaceMb:1536,idleInTransactionMs:journal.idleMs}),
});
/** Trusted server configuration only; tool arguments never select an executable, class or resource override. */
export interface AuditProcessConfig {nodePath:string;entryPath:string;workerClass:AuditWorkerClass}
export interface AuditProcessObservation {
 unitName:string;exitCode:number|null;signal:string|null;
 elapsedMs:number;memoryPeakBytes:number|null;oomKilled:boolean;
 /** Sampled resident bytes for the dedicated child PID, distinct from the kernel cgroup peak. */
 peakRssBytes:number|null;
}
