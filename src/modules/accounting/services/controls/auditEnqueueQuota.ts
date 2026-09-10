import type {ControlTx} from './contracts';
import type {AuditJobKind} from './auditJobContract';
import {AUDIT_CHECK_RUN_QUOTA} from './auditCheckRunContract';
/**
 * Every audit job kind is bounded by a RATE, never an absolute count: a company cap over a trailing window on the
 * database clock, and beneath it a per-member share, so one principal — a looping agent, a read-only token that should
 * never have got this far — cannot spend a colleague's allowance. Old jobs stop counting, so nothing locks a tenant
 * out for good. Sized per job class: snapshots and exports are the memory- and byte-heavy ones. Whether any of these
 * should be tighter is Hein's decision with the measured storage rate in front of him (plan v10).
 */
export const AUDIT_ENQUEUE_QUOTAS=Object.freeze({
 audit_snapshot:Object.freeze({windowHours:24,perCompany:50,perPrincipal:20}),
 audit_export:Object.freeze({windowHours:24,perCompany:50,perPrincipal:20}),
 audit_compare:Object.freeze({windowHours:24,perCompany:100,perPrincipal:40}),
 audit_check_run:Object.freeze({windowHours:AUDIT_CHECK_RUN_QUOTA.windowHours,perCompany:AUDIT_CHECK_RUN_QUOTA.maxJobsPerWindow,perPrincipal:AUDIT_CHECK_RUN_QUOTA.maxJobsPerPrincipal}),
} satisfies Record<AuditJobKind,{windowHours:number;perCompany:number;perPrincipal:number}>);
const LABELS:Readonly<Record<AuditJobKind,string>>=Object.freeze({audit_snapshot:'snapshot',audit_export:'export',audit_compare:'comparison',audit_check_run:'check-run'});
/** A refused enqueue: a rate a caller may retry later, never a server fault. */
export class AuditEnqueueQuotaError extends Error {
 constructor(readonly kind:AuditJobKind,readonly bound:'company'|'member'|'active'){
  super(`Audit ${LABELS[kind]} quota exceeded (${bound})`);this.name='AuditEnqueueQuotaError';
 }
}
/**
 * Call inside the enqueue's own savepoint, after its idempotency lookup (a repeat never counts) and after authority
 * (a refused member learns nothing about company usage). One lock per company and kind serialises the count and the
 * insert it guards, so concurrent enqueues by different members cannot both see room for the last slot.
 */
export async function assertAuditEnqueueQuota(ctx:ControlTx,kind:AuditJobKind,count:number,maxActive?:number):Promise<void>{
 const quota=AUDIT_ENQUEUE_QUOTAS[kind],principal=ctx.principal;
 await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`audit-enqueue:${kind}:${principal.companyId}`},0))`;
 const [usage]=await ctx.sql`SELECT
   count(*) FILTER(WHERE i.created_at>clock_timestamp()-make_interval(hours=>${quota.windowHours}::int))::int AS company,
   count(*) FILTER(WHERE i.requester_person_id=${principal.personId} AND i.created_at>clock_timestamp()-make_interval(hours=>${quota.windowHours}::int))::int AS member,
   count(*) FILTER(WHERE j.state IN('queued','running'))::int AS active
  FROM control_audit_job_intents i JOIN control_audit_jobs j ON j.company_id=i.company_id AND j.job_id=i.id
  WHERE i.company_id=${principal.companyId}::uuid AND i.kind=${kind}` as {company:number;member:number;active:number}[];
 if(!usage)throw new Error('Audit enqueue usage unavailable');
 if(maxActive!==undefined&&usage.active+count>maxActive)throw new AuditEnqueueQuotaError(kind,'active');
 if(usage.company+count>quota.perCompany)throw new AuditEnqueueQuotaError(kind,'company');
 if(usage.member+count>quota.perPrincipal)throw new AuditEnqueueQuotaError(kind,'member');
}
