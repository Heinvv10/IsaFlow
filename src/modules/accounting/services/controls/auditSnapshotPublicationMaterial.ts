import {canonicalJson} from './canonical';
import {verifySnapshotArtifact,type AuditSnapshotData} from './auditSnapshotSeal';
import type {AuditSnapshotRequest} from './auditJobContract';
export interface SnapshotArtifactBytes {id:string;bytes:Uint8Array}
const actualByteLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
const families:Record<AuditSnapshotRequest['sources'][number],readonly string[]>={
 journals:['journal_entry','journal_line'],
 ar:['customer_invoice','customer_invoice_line','customer_payment','customer_payment_allocation'],
 ap:['supplier_invoice','supplier_invoice_line','supplier_payment','supplier_payment_allocation'],
 bank:['bank_transaction','bank_statement_import','bank_statement_attestation_intent'],payroll:['payroll_run','payroll_run_line'],
};
export function assertSnapshotRequest(snapshot:AuditSnapshotData,request:AuditSnapshotRequest){
 if(snapshot.cutoff!==request.cutoff)throw new Error('Snapshot cutoff differs from request');
 const expected=request.sources.flatMap(source=>families[source]).sort(),actual=snapshot.populations.map(row=>row.source).sort();
 if(canonicalJson(expected)!==canonicalJson(actual))throw new Error('Snapshot population differs from requested sources');
 if(canonicalJson([...request.checks].sort())!==canonicalJson(snapshot.checks.map(check=>check.checkId).sort()))throw new Error('Snapshot checks differ from request');
}
/** Detach bytes before any await; getters and extra metadata never participate in retained evidence. */
export function copySnapshotArtifacts(value:readonly SnapshotArtifactBytes[]):SnapshotArtifactBytes[]{
 if(!Array.isArray(value)||value.length>100000)throw new Error('Invalid snapshot artifacts');
 let total=0;const ids=new Set<string>(),copied:SnapshotArtifactBytes[]=[];
 for(let index=0;index<value.length;index++){
  const item=Object.getOwnPropertyDescriptor(value,String(index));
  if(!item||!('value'in item)||!item.value||typeof item.value!=='object')throw new Error('Invalid snapshot artifact');
  const descriptors=Object.getOwnPropertyDescriptors(item.value),id=descriptors.id,bytes=descriptors.bytes;
  if(Reflect.ownKeys(item.value).length!==2||!id||!bytes||!('value'in id)||!('value'in bytes)
   ||typeof id.value!=='string'||!id.value||id.value.length>256||!(bytes.value instanceof Uint8Array)||ids.has(id.value))throw new Error('Invalid snapshot artifact');
  total+=actualByteLength.call(bytes.value);if(total>100*1024*1024)throw new Error('Snapshot artifact resource limit');
  ids.add(id.value);copied.push({id:id.value,bytes:new Uint8Array(bytes.value)});
 }
 return copied;
}
export function assertSnapshotArtifacts(snapshot:AuditSnapshotData,artifacts:readonly SnapshotArtifactBytes[]){
 if(snapshot.evidence.length!==artifacts.length)throw new Error('Snapshot artifact population is incomplete');
 for(const artifact of artifacts)verifySnapshotArtifact(snapshot,artifact.id,artifact.bytes);
}
