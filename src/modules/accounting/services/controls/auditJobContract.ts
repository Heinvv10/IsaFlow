import {z} from 'zod';
import {isRealCalendarDate} from '@/lib/validation';
export const AUDIT_SOURCE_TYPES=['journals','ar','ap','bank','payroll'] as const;
export const AUDIT_CHECK_IDS=['duplicate_invoice_checks','payment_risk_checks','three_way_match_exceptions','journal_risk_checks','bank_statement_completeness','payroll_control_checks'] as const;
/** Every kind the shared intent CHECK must name; migrations assert against this list. */
export const AUDIT_JOB_KINDS=['audit_snapshot','audit_export','audit_compare','audit_check_run'] as const;
export type AuditJobKind=typeof AUDIT_JOB_KINDS[number];
export const AUDIT_JOB_LIMITS=Object.freeze({pageSize:1000,maxRecords:100000,maxRunSeconds:60,maxAttempts:3,leaseSeconds:90});
const schema=z.object({
 cutoff:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealCalendarDate),
 sources:z.array(z.enum(AUDIT_SOURCE_TYPES)).min(1).max(5),
 checks:z.array(z.enum(AUDIT_CHECK_IDS)).max(6),
 idempotencyKey:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
}).strict();
export type AuditSnapshotRequest=z.infer<typeof schema>;
const checkSources:Record<typeof AUDIT_CHECK_IDS[number],readonly typeof AUDIT_SOURCE_TYPES[number][]>={
 duplicate_invoice_checks:['ap'],payment_risk_checks:['ap','bank'],three_way_match_exceptions:['ap'],
 journal_risk_checks:['journals'],bank_statement_completeness:['bank'],payroll_control_checks:['payroll'],
};
/** No requester, role, scope or resource-limit override is accepted from a transport. */
export function parseAuditSnapshotRequest(input:unknown):AuditSnapshotRequest{
 const parsed=schema.parse(input);
 if(parsed.checks.some(check=>checkSources[check].some(source=>!parsed.sources.includes(source))))throw new Error('Requested check requires its complete source family');
 return{...parsed,sources:[...new Set(parsed.sources)].sort(),checks:[...new Set(parsed.checks)].sort()};
}
export function auditSnapshotPermissions(request:AuditSnapshotRequest):string[]{
 const permissions=['read:reports'];
 if(request.sources.some(source=>source==='ar'||source==='ap'))permissions.push('read:invoices');
 if(request.sources.includes('bank'))permissions.push('read:bank-tx');
 if(request.sources.includes('payroll'))permissions.push('read:payroll');
 return permissions.sort();
}
