import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {resolveEffectivePermissions,EffectivePermissionError} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import {approvalOperationNames,operationPermission} from './operationPermissions';
import type {ControlTx,OperationApproval} from './contracts';
import type {ApprovalSummary} from './approvalQueries';
const statuses=['pending','approved','rejected','cancelled','consumed'] as const;
const optionsSchema=z.object({status:z.enum(statuses).optional(),limit:z.number().int().min(1).max(100).optional(),cursor:z.string().min(1).max(2048).optional()}).strict();
export interface ApprovalListOptions {status?:OperationApproval['status'];limit?:number;cursor?:string}
const cursorSchema=z.object({version:z.literal(1),companyId:z.string().uuid(),status:z.enum(statuses).nullable(),operationsHash:z.string().regex(/^[a-f0-9]{64}$/),
 requestedAt:z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/),id:z.string().uuid()}).strict();
type Cursor=z.infer<typeof cursorSchema>;
function signature(encoded:string){
 const key=process.env.CONTROL_FINGERPRINT_KEY;
 if(!key||key.length<32)throw new Error('Approval cursor signing key is unavailable');
 return createHmac('sha256',key).update('isaflow:approval-cursor:v1\0').update(encoded).digest();
}
function encodeCursor(cursor:Cursor){const encoded=Buffer.from(JSON.stringify(cursor)).toString('base64url');return `${encoded}.${signature(encoded).toString('hex')}`;}
function decodeCursor(value:string):Cursor{
 const parts=value.split('.'),encoded=parts[0],mac=parts[1];
 if(parts.length!==2||!encoded||!mac||!/^[A-Za-z0-9_-]+$/.test(encoded)||!/^[a-f0-9]{64}$/.test(mac)
  ||!timingSafeEqual(signature(encoded),Buffer.from(mac,'hex')))throw new Error('Invalid approval cursor');
 try{
  const decoded=Buffer.from(encoded,'base64url');if(decoded.toString('base64url')!==encoded)throw new Error('Noncanonical cursor');
  return cursorSchema.parse(JSON.parse(decoded.toString('utf8')));
 }catch{throw new Error('Invalid approval cursor');}
}
type Row={id:string;status:OperationApproval['status'];operation:string;entity_type:string;entity_id:string;requested_at:Date|string;expires_at:Date|string;cursor_time:string};
/** Domain permissions filter the database population before LIMIT; hidden domains never produce page gaps. */
export async function listOperationApprovals(ctx:ControlTx,input:ApprovalListOptions={}){
 assertControlTx(ctx);const options=optionsSchema.parse(input),limit=options.limit??50;
 const rights=await resolveEffectivePermissions(ctx);
 if(!rights.permissions.includes('read:approvals'))throw new EffectivePermissionError();
 const allowed=approvalOperationNames().filter(operation=>rights.permissions.includes(operationPermission(operation,'read'))).sort();
 const operationsHash=createHash('sha256').update(JSON.stringify(allowed)).digest('hex'),status=options.status??null,company=ctx.principal.companyId;
 const cursor=options.cursor?decodeCursor(options.cursor):null;
 if(cursor&&(cursor.companyId!==company||cursor.status!==status||cursor.operationsHash!==operationsHash))throw new Error('Approval cursor no longer matches this authorized query');
 if(!allowed.length)return{items:[] as ApprovalSummary[],nextCursor:null};
 const rows=await ctx.sql`SELECT id,status,operation,entity_type,entity_id,requested_at,expires_at,requested_at::text AS cursor_time
  FROM control_operation_approvals WHERE company_id=${company}::uuid AND operation=ANY(${allowed}::text[])
   AND (${status}::text IS NULL OR status=${status})
   AND (${cursor?.requestedAt??null}::timestamptz IS NULL OR (requested_at,id)<(${cursor?.requestedAt??null}::timestamptz,${cursor?.id??null}::uuid))
  ORDER BY requested_at DESC,id DESC LIMIT ${limit+1}` as Row[];
 const page=rows.slice(0,limit),iso=(value:Date|string)=>value instanceof Date?value.toISOString():value;
 const items:ApprovalSummary[]=page.map(row=>({id:row.id,status:row.status,operation:row.operation,entityType:row.entity_type,entityId:row.entity_id,requestedAt:iso(row.requested_at),expiresAt:iso(row.expires_at)}));
 const last=page.at(-1);
 return{items,nextCursor:rows.length>limit&&last?encodeCursor({version:1,companyId:company,status,operationsHash,requestedAt:last.cursor_time,id:last.id}):null};
}
