import type {AuditWorkerResult} from './auditJobRunner';
import {AUDIT_JOB_LIMITS,type AuditWorkerClass} from './auditJobContract';
import {AUDIT_CHECK_RUN_LIMITS} from './auditCheckRunContract';
/** Root-owned cold process boundary. Never transfer a principal, lease or financial payload. */
export interface AuditProcessRequest {version:1;companyId:string;personId:string;jobId:string}
export interface AuditProcessReply {version:1;result:AuditWorkerResult}
export interface AuditClassLimits {
 /** Runner abort timer anchored at the parent's spawn timestamp; readiness, start-up, claim and work all spend it. */
 workDeadlineMs:number;claimDeadlineMs:number;unknownPublicationMs:number;failureRecordMs:number;
 /** Parent SIGTERM, then SIGKILL after killGraceMs; systemd RuntimeMaxSec is the outer wall. */
 maxRuntimeMs:number;killGraceMs:number;runtimeMaxSec:number;memoryMaxBytes:number;maxOldSpaceMb:number;idleInTransactionMs:number|null;
}
const journal=AUDIT_CHECK_RUN_LIMITS.journal_risk_checks;
/**
 * `audit` is unchanged. `check_run` is spike-derived (plan v6 A11). All budgets start at the parent's spawn:
 * work 300 (readiness, start-up and the 5 s claim inside it) + unknown 10 + failure 5 = 315 s < parent SIGTERM 325 s
 * <= RuntimeMaxSec 340 - killGrace 2, and the claimed lease maxRuntime + grace = 330 s covers everything after the claim.
 */
export const AUDIT_PROCESS_LIMITS=Object.freeze({
 maxRequestBytes:2048,maxReplyBytes:2048,maxDiagnosticBytes:8192,
 audit:Object.freeze<AuditClassLimits>({workDeadlineMs:AUDIT_JOB_LIMITS.maxRunSeconds*1000,claimDeadlineMs:5000,unknownPublicationMs:0,failureRecordMs:5000,
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
