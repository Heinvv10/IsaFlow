import {z} from 'zod';
const fields={snapshotId:z.string().uuid(),idempotencyKey:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)};
const publicSchema=z.object(fields).strict();
const storedSchema=z.object({...fields,canonicalSnapshotHash:z.string().regex(/^[a-f0-9]{64}$/),
 permissions:z.array(z.enum(['read:reports','read:invoices','read:bank-tx','read:payroll'])).min(1).max(4)
  .refine(value=>value.includes('read:reports')&&new Set(value).size===value.length&&value.join(',')===[...value].sort().join(',')),
}).strict();
export type AuditExportRequest=z.infer<typeof publicSchema>;
export type StoredAuditExportRequest=z.infer<typeof storedSchema>;
/** Only enqueue may derive the additional immutable fields from an authenticated index header. */
export const parseAuditExportRequest=(input:unknown):AuditExportRequest=>publicSchema.parse(input);
export const parseStoredAuditExportRequest=(input:unknown):StoredAuditExportRequest=>storedSchema.parse(input);
