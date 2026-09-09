import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {UUID_RE} from '@/lib/validation';
import {assertControlTx} from './context';
import type {ControlTx} from './contracts';
import {readCapturedStorageEvidence} from './capturedEvidenceStorage';
type EvidencePermission='read:reports'|'read:invoices'|'read:bank-tx'|'write:bank-tx'|'read:payroll';
interface DocumentRow{id:string;status:string|null;storage_bucket:string|null;storage_path:string|null;raw_bytes_sha256:string|null;raw_bytes_size:number|null;file_type:string}
const mediaTypes:Record<string,string>={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',csv:'text/csv'};
/** Internal shared source read. Domain callers must also validate their source-parent association. */
export async function loadOwnedCapturedEvidence(ctx:ControlTx,id:string,permission:EvidencePermission,signal?:AbortSignal){
 assertControlTx(ctx);
 if(!UUID_RE.test(id))throw new Error('Invalid captured evidence identity');
 await assertEffectivePermission(ctx,permission);
 const [row]=await ctx.sql`SELECT id,status,storage_bucket,storage_path,raw_bytes_sha256,raw_bytes_size,file_type
  FROM captured_documents WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid FOR SHARE` as DocumentRow[];
 if(!row||['deleted','rejected'].includes(row.status??'')||!row.storage_path)return null;
 const evidence=await readCapturedStorageEvidence({companyId:ctx.principal.companyId,documentId:row.id,
  bucket:row.storage_bucket??process.env.SUPABASE_CAPTURED_DOCS_BUCKET??'captured-documents',path:row.storage_path,
  recordedHash:row.raw_bytes_sha256,recordedSize:row.raw_bytes_size,mediaType:mediaTypes[row.file_type]??'application/octet-stream'},signal);
 return evidence?{...evidence,id:row.id,status:row.status}:null;
}
