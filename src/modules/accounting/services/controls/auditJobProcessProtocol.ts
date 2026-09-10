import {z} from 'zod';
import {AUDIT_PROCESS_LIMITS,type AuditProcessConfig,type AuditProcessRequest,type AuditProcessReply} from './auditJobProcessContract';
const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const request=z.object({version:z.literal(1),companyId:id,personId:z.string().min(1).max(256),jobId:id}).strict();
const reply=z.object({version:z.literal(1),result:z.union([
 z.object({state:z.enum(['busy','not_claimed'])}).strict(),
 z.object({state:z.literal('succeeded'),snapshotId:id,canonicalHash:hash}).strict(),
 z.object({state:z.literal('succeeded'),exportId:id,canonicalHash:hash}).strict(),
 z.object({state:z.literal('succeeded'),comparisonId:id,canonicalHash:hash}).strict(),
 z.object({state:z.literal('failed'),code:z.enum(['SOURCE_UNAVAILABLE','AUTHORITY_REVOKED','EVIDENCE_CHANGED','RESOURCE_LIMIT','WORKER_ERROR','RETRY_EXHAUSTED','CANCELLED']),failureRecorded:z.boolean()}).strict(),
])}).strict();
function boundedJson(bytes:Uint8Array,max:number):unknown{
 if(!bytes.byteLength||bytes.byteLength>max)throw new Error('Audit process protocol size invalid');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('Audit process protocol invalid');}
}
export function decodeAuditProcessRequest(bytes:Uint8Array):AuditProcessRequest{return request.parse(boundedJson(bytes,AUDIT_PROCESS_LIMITS.maxRequestBytes));}
export function encodeAuditProcessRequest(value:unknown):Buffer{
 const bytes=Buffer.from(JSON.stringify(request.parse(value))+'\n');decodeAuditProcessRequest(bytes);return bytes;
}
export function decodeAuditProcessReply(bytes:Uint8Array):AuditProcessReply{return reply.parse(boundedJson(bytes,AUDIT_PROCESS_LIMITS.maxReplyBytes));}
export function encodeAuditProcessReply(value:AuditProcessReply):Buffer{const bytes=Buffer.from(JSON.stringify(value)+'\n');decodeAuditProcessReply(bytes);return bytes;}
export const AUDIT_PROCESS_ENV=['ISAFLOW_AUDIT_WORKER_DATABASE_URL','PGPASSWORD','PGPASSFILE','PGUSER','DATABASE_SSL','ENCRYPTION_KEY','CONTROL_FINGERPRINT_KEY','CONTROL_SNAPSHOT_SIGNING_KEY',
 'CONTROL_SNAPSHOT_KEY_ID','CONTROL_ENCRYPTION_KEY_ID','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_CAPTURED_DOCS_BUCKET','VF_STORAGE_URL'] as const;
export function auditProcessArguments(config:AuditProcessConfig,unitName:string):string[]{
 if(!/^isaflow-audit-[a-f0-9-]{36}\.service$/.test(unitName))throw new Error('Invalid dedicated audit unit');
 return['--user','--quiet','--wait','--pipe','--no-ask-password',`--unit=${unitName}`,'--property=Type=exec',
  `--property=MemoryMax=${AUDIT_PROCESS_LIMITS.memoryMaxBytes}`,'--property=MemorySwapMax=0','--property=MemoryAccounting=yes',
  '--property=OOMPolicy=kill','--property=TasksMax=64','--property=RuntimeMaxSec=65s','--property=TimeoutStopSec=2s','--property=KillMode=control-group',
  '--property=SendSIGKILL=yes','--setenv=NODE_ENV=production',...AUDIT_PROCESS_ENV.filter(name=>process.env[name]!==undefined).map(name=>`--setenv=${name}`),
  config.nodePath,'--max-old-space-size=4096',config.entryPath];
}
