import {createHash,randomUUID} from 'node:crypto';
import {als} from '@/lib/als';
import {withSavepoint} from '@/lib/neon';
import {UUID_RE} from '@/lib/validation';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {assertControlTx} from './context';
import {protectChangeValues,openProtectedChange,type ProtectedChange} from './changeProtection';
import {recordCommittedChange} from './changeEventService';
import {BeneficiaryError,type BeneficiaryRef} from './beneficiaryValidation';
import type {ControlTx,EvidenceRef} from './contracts';
const MAX_BYTES=10*1024*1024;
const MIME=new Set(['application/pdf','image/png','image/jpeg']);
function matchesMagic(bytes:Buffer,mime:string):boolean {
 if(mime==='application/pdf')return bytes.subarray(0,5).toString('ascii')==='%PDF-';
 if(mime==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 return mime==='image/jpeg'&&bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
}
interface EvidenceRow {id:string;company_id:string;employee_id:string;document_envelope:ProtectedChange;content_sha256:string;byte_length:number;mime_type:string}
function decode(ctx:ControlTx,row:EvidenceRow):{bytes:Buffer;mimeType:string}{
 try{
  const body=openProtectedChange(row.document_envelope).after;
  if(!body||body.companyId!==ctx.principal.companyId||body.employeeId!==row.employee_id||body.hash!==row.content_sha256
   ||body.mimeType!==row.mime_type||!MIME.has(row.mime_type)||typeof body.bodyBase64!=='string')throw new Error('binding');
  const bytes=Buffer.from(body.bodyBase64,'base64');
  if(!matchesMagic(bytes,row.mime_type)||!bytes.length||bytes.length>MAX_BYTES||bytes.length!==row.byte_length||bytes.toString('base64')!==body.bodyBase64
   ||createHash('sha256').update(bytes).digest('hex')!==row.content_sha256)throw new Error('bytes');
  return{bytes,mimeType:row.mime_type};
 }catch{throw new BeneficiaryError('EVIDENCE_UNAVAILABLE_OR_CHANGED');}
}
async function load(ctx:ControlTx,id:string):Promise<EvidenceRow>{
 if(!UUID_RE.test(id))throw new BeneficiaryError('INVALID_EVIDENCE');
 const rows=await ctx.sql`SELECT d.* FROM control_employee_beneficiary_evidence d
  JOIN payroll_employees e ON e.id=d.employee_id AND e.company_id=d.company_id
  WHERE d.company_id=${ctx.principal.companyId}::uuid AND d.id=${id}::uuid FOR SHARE OF e` as EvidenceRow[];
 if(rows.length!==1)throw new BeneficiaryError('EVIDENCE_UNAVAILABLE_OR_CHANGED');
 return rows[0]!;
}
/** Persist an explicitly associated, actual document; never create a generic captured-document copy. */
export async function storeEmployeeBeneficiaryEvidence(ctx:ControlTx,input:{employeeId:string;bytes:Buffer;mimeType:string}):Promise<EvidenceRef>{
 try{
  assertControlTx(ctx);
  if(!UUID_RE.test(input.employeeId)||!Buffer.isBuffer(input.bytes)||!input.bytes.length||input.bytes.length>MAX_BYTES||!MIME.has(input.mimeType)||!matchesMagic(input.bytes,input.mimeType))throw new BeneficiaryError('INVALID_EVIDENCE');
  const bytes=Buffer.from(input.bytes);
  const employeeId=input.employeeId.toLowerCase(),ref={entityType:'employee' as const,entityId:employeeId};
  await assertEffectivePermission(ctx,'write:payroll',ref);await assertEffectivePermission(ctx,'write:beneficiaries',ref);
  return await withSavepoint(`emp_evidence_${randomUUID().replaceAll('-','').slice(0,15)}`,async()=>{
   await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-payroll:${ctx.principal.companyId}`},0))`;
   const parent=await ctx.sql`SELECT id FROM payroll_employees WHERE company_id=${ctx.principal.companyId}::uuid AND id=${employeeId}::uuid FOR SHARE`;
   if(parent.length!==1)throw new BeneficiaryError('NOT_FOUND');
   const id=randomUUID(),hash=createHash('sha256').update(bytes).digest('hex');
   const envelope=protectChangeValues('employee_beneficiary_evidence',null,{companyId:ctx.principal.companyId,employeeId,hash,mimeType:input.mimeType,bodyBase64:bytes.toString('base64')}).protectedPayload;
   await ctx.sql`INSERT INTO control_employee_beneficiary_evidence(company_id,id,employee_id,document_envelope,content_sha256,byte_length,mime_type,created_by_person_id)
    VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${employeeId}::uuid,${JSON.stringify(envelope)}::jsonb,${hash},${bytes.length},${input.mimeType},${ctx.principal.personId})`;
   await recordCommittedChange(ctx,{entityType:'employee_beneficiary_evidence',entityId:id,previousVersion:null,newVersion:1,
    action:'employee.beneficiary_evidence',accountingDate:null,before:null,after:{employeeId,status:'recorded',hash,byteLength:bytes.length,mimeType:input.mimeType},bindingHash:null,protectedEvidenceRef:null});
   return{store:'protected',...ref,evidenceId:id,version:null,hash};
  });
 }catch(error){const state=als.getStore();if(state)state.controlWriteFailed=true;throw error;}
}
/** Explicit restricted document viewing only; never expose this result in generic history/graph APIs. */
export async function readEmployeeBeneficiaryEvidence(ctx:ControlTx,evidenceId:string):Promise<{bytes:Buffer;mimeType:string}>{
 assertControlTx(ctx);
 if(ctx.principal.authMethod!=='cookie'||ctx.principal.provenance!=='human')throw new BeneficiaryError('HUMAN_REQUIRED');
 await assertEffectivePermission(ctx,'read:payroll');await assertEffectivePermission(ctx,'read:payroll-sensitive');
 return decode(ctx,await load(ctx,evidenceId));
}
export async function validateEmployeeBeneficiaryEvidence(ctx:ControlTx,ref:BeneficiaryRef,evidence:readonly EvidenceRef[]):Promise<EvidenceRef[]>{
 assertControlTx(ctx);
 if(ref.entityType!=='employee'||!Array.isArray(evidence)||evidence.length<1||evidence.length>10)throw new BeneficiaryError('EVIDENCE_REQUIRED');
 const result:EvidenceRef[]=[];
 for(const e of [...evidence].sort((a,b)=>a.evidenceId<b.evidenceId?-1:1)){
  if(e.store!=='protected'||e.entityType!=='employee'||e.entityId!==ref.entityId||!UUID_RE.test(e.evidenceId)||e.version!==null
   ||!e.hash||!/^[a-f0-9]{64}$/.test(e.hash)||result.some(r=>r.evidenceId===e.evidenceId))throw new BeneficiaryError('INVALID_EVIDENCE');
  const row=await load(ctx,e.evidenceId);
  if(row.employee_id!==ref.entityId||row.content_sha256!==e.hash)throw new BeneficiaryError('EVIDENCE_UNAVAILABLE_OR_CHANGED');
  decode(ctx,row);
  result.push({store:'protected',entityType:'employee',entityId:ref.entityId,evidenceId:e.evidenceId,version:null,hash:e.hash});
 }
 return result;
}
