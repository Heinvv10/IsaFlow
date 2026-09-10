import {z} from 'zod';
import {canonicalJson} from './canonical';
import {indexCryptography} from './auditSnapshotIndexCrypto';
import type {SnapshotIndexEnvelope} from './auditSnapshotIndexContract';
import {AUDIT_CHECK_RUN_IDS,AUDIT_CHECK_RUN_LIMITS} from './auditCheckRunContract';
const hash=z.string().regex(/^[a-f0-9]{64}$/),reason=z.string().min(1).max(256);
const maxFindings=AUDIT_CHECK_RUN_LIMITS.journal_risk_checks.maxFindings;
/**
 * `message` is the detector's proven maximum (6 fixed signals plus at most 100 threshold reasons of uuid id and bigint
 * version — 8 663 ASCII characters, measured) rounded up, so no message sync writes is refused. Amount is numeric text.
 * The currency is the company's unbounded default_currency, and the table's limit is BYTES: octet_length of the
 * hex-encoded envelope <= 64 KiB. So the currency is bounded by what it costs inside the sealed plaintext — canonical
 * JSON, then UTF-8, where a U+0001 escapes to six bytes — never by UTF-16 code units, which let 16 384 non-ASCII
 * characters past the seal and into the CHECK mid-run. A run checks its company's currency against the same measure
 * before streaming and publishes `unknown` if it does not fit: sync would accept such a currency, the stream cannot seal
 * it, and that divergence is stated, not hidden. 1 024 bytes also keeps what a run holds per staged finding small.
 */
export const CHECK_RUN_ITEM_BOUNDS=Object.freeze({message:9216,currencyBytes:1024,amount:1024});
/** A currency's cost inside the sealed plaintext, measured as the seal encodes it. */
export function checkRunCurrencyFits(currency:string):boolean{
 return Buffer.byteLength(JSON.stringify(currency),'utf8')-2<=CHECK_RUN_ITEM_BOUNDS.currencyBytes;
}
const identitySchema=z.object({companyId:z.string().uuid(),checkRunId:z.string().uuid(),generation:z.number().int().positive(),leaseId:z.string().uuid()}).strict();
const money=z.record(z.string().regex(/^[A-Z]{3}$/),z.string().regex(/^-?\d+(\.\d+)?$/));
const headerSchema=identitySchema.extend({version:z.literal(1),checkId:z.enum(AUDIT_CHECK_RUN_IDS),checkVersion:z.literal(1),
 cutoff:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),status:z.enum(['pass','fail','unknown']),
 populationCount:z.number().int().min(0),excludedCount:z.number().int().min(0),findingCount:z.number().int().min(0).max(maxFindings),
 populationCountBasis:z.enum(['streamed','recount_after_limit']),amountTotals:money,coverage:z.array(reason).max(32),
 missingSources:z.array(reason).max(256),populationDigest:hash,findingsDigest:hash,sourceVersionCount:z.number().int().min(0),
 permissions:z.array(z.enum(['read:reports','read:invoices','read:bank-tx','read:payroll'])).min(1).max(4),canonicalHash:hash,
}).strict().refine(row=>row.status!=='unknown'||row.findingCount===0,'An unknown check run carries no findings')
 .refine(row=>canonicalJson(row.missingSources)===canonicalJson([...new Set(row.missingSources)].sort()),'Missing sources are a sorted set');
const entity=z.object({entityType:z.string().min(1).max(64),entityId:z.string().min(1).max(256)}).strict();
const findingSchema=z.object({key:hash,kind:z.string().min(1).max(128),severity:z.enum(['low','medium','high']),
 classification:z.enum(['candidate','confirmed']),entities:z.array(entity).max(8),message:z.string().min(1).max(CHECK_RUN_ITEM_BOUNDS.message),
 evidence:z.tuple([])}).strict();
const itemSchema=identitySchema.extend({version:z.literal(1),ordinal:z.number().int().min(0).max(maxFindings-1),
 amount:z.string().max(CHECK_RUN_ITEM_BOUNDS.amount),currency:z.string().refine(checkRunCurrencyFits,'Check run currency exceeds its sealed-byte bound'),finding:findingSchema}).strict();
export type CheckRunIdentity=z.infer<typeof identitySchema>;
export type CheckRunHeader=z.infer<typeof headerSchema>;
export type CheckRunItem=z.infer<typeof itemSchema>;
const headers=new WeakSet<CheckRunHeader>();
const detach=(value:unknown):unknown=>JSON.parse(canonicalJson(value));
const same=(a:CheckRunIdentity,b:CheckRunIdentity)=>a.companyId===b.companyId&&a.checkRunId===b.checkRunId&&a.generation===b.generation&&a.leaseId===b.leaseId;
function freeze(value:unknown):void{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
/** Internal publication primitives: callers derive material from the population stream and recheck the current lease. */
export function sealAuditCheckRunHeader(value:unknown):SnapshotIndexEnvelope{
 return indexCryptography().seal('audit-check-run-header',headerSchema.parse(detach(value)));
}
/** Findings are staged before the header's counts are final; only the header and success pointer publish the run. */
export function sealAuditCheckRunItem(identity:CheckRunIdentity,ordinal:number,value:unknown):SnapshotIndexEnvelope{
 const bound=identitySchema.parse(detach(identity));
 return indexCryptography().seal('audit-check-run-item',itemSchema.parse({...bound,version:1,ordinal,...(detach(value) as object)}));
}
export function openAuditCheckRunHeader(envelope:SnapshotIndexEnvelope,expected:CheckRunIdentity):CheckRunHeader{
 const bound=identitySchema.parse(detach(expected)),header=headerSchema.parse(indexCryptography().open('audit-check-run-header',envelope));
 if(!same(header,bound))throw new Error('Audit check run identity changed');
 freeze(header);headers.add(header);return header;
}
/** A page item is only readable through a header this process verified, and only inside that header's finding count. */
export function openAuditCheckRunItem(envelope:SnapshotIndexEnvelope,header:CheckRunHeader,ordinal:number):CheckRunItem{
 if(!headers.has(header))throw new Error('Verified check run header and ordinal required');
 return openBoundItem(envelope,header,header.findingCount,ordinal);
}
/**
 * The publishing transaction has no sealed header yet — it is reading its own findings back to build one — so it binds
 * the read to the lease identity and the count it staged instead. Readers never take this path.
 */
export function openRetainedAuditCheckRunItem(envelope:SnapshotIndexEnvelope,identity:CheckRunIdentity,stagedCount:number,ordinal:number):CheckRunItem{
 return openBoundItem(envelope,identitySchema.parse(detach(identity)),z.number().int().min(0).max(maxFindings).parse(stagedCount),ordinal);
}
function openBoundItem(envelope:SnapshotIndexEnvelope,bound:CheckRunIdentity,count:number,ordinal:number):CheckRunItem{
 if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=count)throw new Error('Verified check run header and ordinal required');
 const row=itemSchema.parse(indexCryptography().open('audit-check-run-item',envelope));
 if(!same(row,bound)||row.ordinal!==ordinal)throw new Error('Audit check run item identity changed');
 freeze(row);return row;
}
