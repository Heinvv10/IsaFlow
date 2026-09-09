import {z} from 'zod';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import type {McpTool} from '../types';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditExport} from '@/modules/accounting/services/controls/auditExportJobService';
import {readAuditSnapshotIndexHeader} from '@/modules/accounting/services/controls/auditSnapshotIndexRead';
import {getAuditSnapshotPage,readAuditSnapshotChunk} from '@/modules/accounting/services/controls/auditSnapshotPageService';
import {getAuditExportFiles,readAuditExportChunk} from '@/modules/accounting/services/controls/auditExportReadService';
import {AUDIT_SOURCE_TYPES,AUDIT_CHECK_IDS,parseAuditSnapshotRequest,auditSnapshotPermissions} from '@/modules/accounting/services/controls/auditJobContract';
import {parseAuditExportRequest} from '@/modules/accounting/services/controls/auditExportJobContract';
import {SNAPSHOT_INDEX_SECTIONS} from '@/modules/accounting/services/controls/auditSnapshotIndexContract';
import {ok,toolError} from './toolHelpers';
const uuid={type:'string',format:'uuid'},key={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_.:-]+$'},
 limit={type:'integer',minimum:1,maximum:100},cursor={type:'string',pattern:'^(0|[1-9][0-9]{0,5})$'},
 section={type:'string',enum:[...SNAPSHOT_INDEX_SECTIONS]},ordinal={type:'integer',minimum:0,maximum:800005};
const id=z.string().uuid(),retry=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),page={limit:z.number().int().min(1).max(100).optional(),cursor:z.string().regex(/^(0|[1-9][0-9]{0,5})$/).optional()};
function tool<T>(name:string,description:string,write:boolean,properties:Record<string,unknown>,required:string[],schema:z.ZodType<T>,run:(input:T)=>Promise<unknown>):McpTool{
 return{name,description,scope:'read:reports',write,inputSchema:{type:'object',additionalProperties:false,properties,required},handler:async args=>{
  const parsed=schema.safeParse(args);if(!parsed.success)return toolError('Invalid audit delivery arguments');
  return ok(await run(parsed.data));
 }};
}
const snapshot=tool('audit_snapshot','Enqueue an immutable accounting snapshot and selected checks. Returns a durable job ID; no scan runs in this request. Current source read permissions are required and rechecked by the worker.',true,
 {cutoff:{type:'string',format:'date'},sources:{type:'array',items:{type:'string',enum:[...AUDIT_SOURCE_TYPES]},minItems:1,maxItems:5},checks:{type:'array',items:{type:'string',enum:[...AUDIT_CHECK_IDS]},maxItems:6},idempotency_key:key},
 ['cutoff','sources','checks','idempotency_key'],z.object({cutoff:z.string(),sources:z.array(z.enum(AUDIT_SOURCE_TYPES)).min(1).max(5),checks:z.array(z.enum(AUDIT_CHECK_IDS)).max(6),idempotency_key:retry}).strict(),
 async({idempotency_key,...request})=>enqueueAuditSnapshot(requireControlTx(),parseAuditSnapshotRequest({...request,idempotencyKey:idempotency_key})));
const exported=tool('export_audit_evidence','Enqueue a complete retained-evidence export, including the signed manifest and original artifacts. Returns job status; use audit_export_files and audit_export_chunk after success. Never renders in the request.',true,
 {snapshot_id:uuid,idempotency_key:key},['snapshot_id','idempotency_key'],z.object({snapshot_id:id,idempotency_key:retry}).strict(),
 async input=>enqueueAuditExport(requireControlTx(),{snapshotId:input.snapshot_id,idempotencyKey:input.idempotency_key}));
const status=tool('audit_job_status','Read your audit job status with current source permissions. This read never claims a lease or starts processing.',false,
 {job_id:uuid},['job_id'],z.object({job_id:id}).strict(),async input=>getAuditJob(requireControlTx(),input.job_id));
const manifest=tool('audit_snapshot_manifest','Read authenticated retained snapshot identity and complete section counts. Does not load full records or rebuild a missing historical index.',false,
 {snapshot_id:uuid},['snapshot_id'],z.object({snapshot_id:id}).strict(),async input=>readAuditSnapshotIndexHeader(requireControlTx(),input.snapshot_id));
const items=tool('audit_snapshot_items','Read at most 100 authenticated retained item descriptors with full section count and continuation cursor. Read item bytes separately with audit_snapshot_chunk.',false,
 {snapshot_id:uuid,section,limit,cursor},['snapshot_id','section'],z.object({snapshot_id:id,section:z.enum(SNAPSHOT_INDEX_SECTIONS),...page}).strict(),
 async({snapshot_id,...options})=>getAuditSnapshotPage(requireControlTx(),{snapshotId:snapshot_id,...options}));
const snapshotChunk=tool('audit_snapshot_chunk','Read one authenticated retained snapshot item chunk, at most 256 KiB of original bytes encoded as base64.',false,
 {snapshot_id:uuid,section,ordinal,chunk_ordinal:{type:'integer',minimum:0,maximum:1023}},['snapshot_id','section','ordinal','chunk_ordinal'],
 z.object({snapshot_id:id,section:z.enum(SNAPSHOT_INDEX_SECTIONS),ordinal:z.number().int().min(0).max(800005),chunk_ordinal:z.number().int().min(0).max(1023)}).strict(),
 async({snapshot_id,chunk_ordinal,...options})=>{const {bytes,...result}=await readAuditSnapshotChunk(requireControlTx(),{snapshotId:snapshot_id,chunkOrdinal:chunk_ordinal,...options});return{...result,bytesBase64:Buffer.from(bytes).toString('base64')};});
const files=tool('audit_export_files','Read at most 100 authenticated file descriptors from a succeeded export, including the complete signed manifest as manifest.json. Current source permissions are required.',false,
 {job_id:uuid,limit,cursor},['job_id'],z.object({job_id:id,...page}).strict(),async({job_id,...options})=>getAuditExportFiles(requireControlTx(),{jobId:job_id,...options}));
const exportChunk=tool('audit_export_chunk','Read one authenticated completed-export chunk, at most 256 KiB of original bytes encoded as base64. Verify the descriptor hash when reassembling a file.',false,
 {job_id:uuid,file_ordinal:{type:'integer',minimum:0,maximum:100005},chunk_ordinal:{type:'integer',minimum:0,maximum:4095}},['job_id','file_ordinal','chunk_ordinal'],
 z.object({job_id:id,file_ordinal:z.number().int().min(0).max(100005),chunk_ordinal:z.number().int().min(0).max(4095)}).strict(),
 async input=>{const {bytes,...result}=await readAuditExportChunk(requireControlTx(),{jobId:input.job_id,fileOrdinal:input.file_ordinal,chunkOrdinal:input.chunk_ordinal});return{...result,bytesBase64:Buffer.from(bytes).toString('base64')};});
snapshot.perUserIdempotency=true;
snapshot.authorize=async({idempotency_key,...input})=>{
 const request=parseAuditSnapshotRequest({...input,idempotencyKey:idempotency_key});
 for(const permission of auditSnapshotPermissions(request))await assertEffectivePermission(requireControlTx(),permission);
};
exported.perUserIdempotency=true;
exported.authorize=async input=>{
 const request=parseAuditExportRequest({snapshotId:input.snapshot_id,idempotencyKey:input.idempotency_key});
 await readAuditSnapshotIndexHeader(requireControlTx(),request.snapshotId);
};
export const auditDeliveryTools=[snapshot,exported,status,manifest,items,snapshotChunk,files,exportChunk] as const;
