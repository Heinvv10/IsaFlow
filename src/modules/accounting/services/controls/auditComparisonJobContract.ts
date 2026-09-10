import {z} from 'zod';
import {parseDeferredAuditComparisonRequest,type DeferredAuditComparisonRequest} from './auditComparisonDeferredContract';
import {canonicalJson} from './canonical';
const fields={firstSnapshotId:z.string().uuid(),secondSnapshotId:z.string().uuid(),
 idempotencyKey:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)};
const publicSchema=z.object(fields).strict();
const storedSchema=z.object({...fields,
 firstCanonicalHash:z.string().regex(/^[a-f0-9]{64}$/),secondCanonicalHash:z.string().regex(/^[a-f0-9]{64}$/),
 permissions:z.array(z.enum(['read:reports','read:invoices','read:bank-tx','read:payroll'])).min(1).max(4)
  .refine(values=>values.includes('read:reports')&&new Set(values).size===values.length&&values.join(',')===[...values].sort().join(',')),
 comparisonRuleVersion:z.literal(1),
}).strict();
export type AuditComparisonRequest=z.infer<typeof publicSchema>;
export type HashPinnedAuditComparisonRequest=z.infer<typeof storedSchema>;
export type StoredAuditComparisonRequest=HashPinnedAuditComparisonRequest|DeferredAuditComparisonRequest;
/** Only enqueue derives hashes and union permissions from both authenticated retained source headers. */
export function parseAuditComparisonRequest(input:unknown):AuditComparisonRequest{
 return publicSchema.parse(JSON.parse(canonicalJson(input)));
}
export function parseStoredAuditComparisonRequest(input:unknown):StoredAuditComparisonRequest{
 const detached:unknown=JSON.parse(canonicalJson(input));
 if(detached&&typeof detached==='object'&&'requestVersion'in detached)return parseDeferredAuditComparisonRequest(detached);
 return storedSchema.parse(detached);
}
