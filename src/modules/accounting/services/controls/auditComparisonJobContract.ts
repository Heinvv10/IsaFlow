import {z} from 'zod';
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
export type StoredAuditComparisonRequest=z.infer<typeof storedSchema>;
/** Only enqueue derives hashes and union permissions from both authenticated retained source headers. */
export function parseAuditComparisonRequest(input:unknown):AuditComparisonRequest{
 return publicSchema.parse(JSON.parse(canonicalJson(input)));
}
export function parseStoredAuditComparisonRequest(input:unknown):StoredAuditComparisonRequest{
 return storedSchema.parse(JSON.parse(canonicalJson(input)));
}
