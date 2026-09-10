import {z} from 'zod';
import {canonicalJson} from './canonical';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const anchor=z.object({snapshotId:uuid,sourceJobId:uuid,sourceRequestHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const schema=z.object({requestVersion:z.literal(2),sourceVerification:z.literal('worker'),comparisonRuleVersion:z.literal(1),
 firstSnapshotId:uuid,secondSnapshotId:uuid,idempotencyKey:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
 firstSource:anchor,secondSource:anchor,
 permissions:z.array(z.enum(['read:reports','read:invoices','read:bank-tx','read:payroll'])).min(1).max(4)
  .refine(values=>values.includes('read:reports')&&new Set(values).size===values.length&&canonicalJson(values)===canonicalJson([...values].sort())),
}).strict().refine(value=>value.firstSource.snapshotId===value.firstSnapshotId&&value.secondSource.snapshotId===value.secondSnapshotId)
 .refine(value=>value.firstSnapshotId!==value.secondSnapshotId||canonicalJson(value.firstSource)===canonicalJson(value.secondSource));
export type DeferredAuditComparisonRequest=z.infer<typeof schema>;
/** Anchors authenticate original intent only. The worker must authenticate retained contents before publishing. */
export function parseDeferredAuditComparisonRequest(input:unknown):DeferredAuditComparisonRequest{
 return schema.parse(JSON.parse(canonicalJson(input)));
}
