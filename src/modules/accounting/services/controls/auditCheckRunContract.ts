import {createHash} from 'node:crypto';
import {z} from 'zod';
import {isRealCalendarDate} from '@/lib/validation';
import {canonicalJson} from './canonical';
/** Checks that may run as durable complete-population jobs. Others stay on the synchronous paged path. */
export const AUDIT_CHECK_RUN_IDS=['journal_risk_checks'] as const;
export type AuditCheckRunId=typeof AUDIT_CHECK_RUN_IDS[number];
/**
 * Measured in the T1 spike (check-run-spike-100k.json, plan v6 "Consolidated limits"): 100k journals in ~116 s.
 * Thresholds follow the sync truncate-and-flag rule, so there is no threshold limit here.
 */
export const AUDIT_CHECK_RUN_LIMITS=Object.freeze({
 journal_risk_checks:Object.freeze({maxRuntimeMs:300000,graceMs:30000,idleMs:15000,fetchRows:1000,maxSlabRows:1000,maxFindings:100000,workMem:'64MB'}),
});
/** Growth bound until retention lands: active = queued or running; published = succeeded. */
export const AUDIT_CHECK_RUN_QUOTA=Object.freeze({maxActiveJobs:6,maxPublishedJobs:100});
const PERMISSIONS:Readonly<Record<AuditCheckRunId,readonly string[]>>=Object.freeze({journal_risk_checks:Object.freeze(['read:reports'])});
const checkId=z.enum(AUDIT_CHECK_RUN_IDS),cutoff=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate);
// The user key stays <=100 so `${userKey}:${checkId}` fits the 128-character intent key (630:5).
const userKey=z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/);
const publicSchema=z.object({cutoff,checks:z.array(checkId).min(1).max(6),idempotencyKey:userKey}).strict();
const storedSchema=z.object({cutoff,checkId,checks:z.array(checkId).min(1).max(AUDIT_CHECK_RUN_IDS.length),userKey,
 idempotencyKey:z.string().min(3).max(128),runGroupId:z.string().uuid(),permissions:z.array(z.string()).min(1).max(4)}).strict();
export type AuditCheckRunRequest=z.infer<typeof publicSchema>;
export type StoredAuditCheckRunRequest=z.infer<typeof storedSchema>;
export function auditCheckRunPermissions(check:AuditCheckRunId):string[]{return [...PERMISSIONS[check]];}
export function auditCheckRunIdempotencyKey(key:string,check:AuditCheckRunId):string{return `${userKey.parse(key)}:${check}`;}
/** Name-based (RFC 9562 v8) group identity: a repeat of the same user key always names the same fan-out. */
export function auditCheckRunGroupId(companyId:string,personId:string,key:string):string{
 const hex=createHash('sha256').update(canonicalJson(['audit-check-run-group-v1',companyId,personId,key])).digest('hex');
 const variant=((parseInt(hex[16]!,16)&0x3)|0x8).toString(16);
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-${variant}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/** No requester, role, permission, limit or group override is accepted from a transport. */
export function parseAuditCheckRunRequest(input:unknown):AuditCheckRunRequest{
 const parsed=publicSchema.parse(JSON.parse(canonicalJson(input)));
 return{...parsed,checks:[...new Set(parsed.checks)].sort()};
}
/** Every derived field must equal its derivation from the rest, so a stored intent cannot widen itself. */
export function parseStoredAuditCheckRunRequest(input:unknown):StoredAuditCheckRunRequest{
 const parsed=storedSchema.parse(JSON.parse(canonicalJson(input)));
 const checks=[...new Set(parsed.checks)].sort();
 if(checks.join(',')!==parsed.checks.join(',')||!checks.includes(parsed.checkId))throw new Error('Stored check-run group is not canonical');
 if(parsed.idempotencyKey!==auditCheckRunIdempotencyKey(parsed.userKey,parsed.checkId))throw new Error('Stored check-run key is not derived');
 if(canonicalJson(parsed.permissions)!==canonicalJson(auditCheckRunPermissions(parsed.checkId)))throw new Error('Stored check-run permissions are not derived');
 return parsed;
}
/** One stored intent per requested check; the group identity binds the principal that issued them. */
export function auditCheckRunIntents(companyId:string,personId:string,request:AuditCheckRunRequest):StoredAuditCheckRunRequest[]{
 const runGroupId=auditCheckRunGroupId(companyId,personId,request.idempotencyKey);
 return request.checks.map(check=>parseStoredAuditCheckRunRequest({cutoff:request.cutoff,checkId:check,checks:request.checks,userKey:request.idempotencyKey,
  idempotencyKey:auditCheckRunIdempotencyKey(request.idempotencyKey,check),runGroupId,permissions:auditCheckRunPermissions(check)}));
}
