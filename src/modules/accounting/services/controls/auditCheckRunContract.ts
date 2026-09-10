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
 * maxSlabRows counts only rows that can join a threshold group (plan v8 A27), measured on the fixed detector: a held
 * row costs 0.7 KiB typically and 15.2 KiB at the 101-change-fact worst case, so 25 000 hold at most ~371 MiB of the
 * 1 536 MiB heap and analyse in ~0.36 s.
 */
export const AUDIT_CHECK_RUN_LIMITS=Object.freeze({
 journal_risk_checks:Object.freeze({maxRuntimeMs:300000,graceMs:30000,idleMs:15000,fetchRows:1000,maxSlabRows:25000,maxFindings:100000,workMem:'64MB'}),
});
/**
 * A RATE bound, never an absolute count: at most 6 active (queued or running), 100 enqueued per company and 40 per
 * member in any trailing 24 hours. The previous cap of 100 published runs, with no retention, made the 101st run a
 * permanent lockout, and a company-only window let one principal deny every colleague. Storage therefore grows without
 * bound until retention exists — a dependency, measured in plan v10, not something a cap may hide.
 */
export const AUDIT_CHECK_RUN_QUOTA=Object.freeze({maxActiveJobs:6,maxJobsPerWindow:100,maxJobsPerPrincipal:40,windowHours:24});
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
/**
 * The key and permissions must equal their derivation from checkId and userKey, so a stored intent cannot widen itself.
 * runGroupId is not re-derived here (company and person are not in the request): it is bound by the authenticated
 * ciphertext and the request hash, like every other stored field.
 */
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
