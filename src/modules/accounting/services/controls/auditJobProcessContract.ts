import type {AuditWorkerResult} from './auditJobRunner';
/** Root-owned cold process boundary. Never transfer a principal, lease or financial payload. */
export interface AuditProcessRequest {version:1;companyId:string;personId:string;jobId:string}
export interface AuditProcessReply {version:1;result:AuditWorkerResult}
export const AUDIT_PROCESS_LIMITS=Object.freeze({
 maxRequestBytes:2048,maxReplyBytes:2048,maxDiagnosticBytes:8192,
 maxRuntimeMs:65000,killGraceMs:2000,memoryMaxBytes:8*1024*1024*1024,
});
/** Trusted server configuration only; tool arguments never select an executable or resource override. */
export interface AuditProcessConfig {nodePath:string;entryPath:string}
export interface AuditProcessObservation {
 unitName:string;exitCode:number|null;signal:string|null;
 elapsedMs:number;memoryPeakBytes:number|null;oomKilled:boolean;
}
