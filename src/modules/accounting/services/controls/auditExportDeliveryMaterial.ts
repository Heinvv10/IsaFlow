import {setImmediate} from 'node:timers/promises';
import {canonicalJson} from './canonical';
import {indexBudget,detachIndexValue} from './auditSnapshotIndexValidation';
import {indexCryptography,indexHash} from './auditSnapshotIndexCrypto';
import type {AuditEvidenceBundle} from './auditEvidenceExportMaterial';
import {deliveryIdentity,deliveryHeader,deliveryFile,deliveryChunk,prepareDelivery} from './auditExportDeliveryValidation';
import {EXPORT_DELIVERY_LIMITS as limits,type ExportDeliveryIdentity,type ExportDeliveryHeader,type ExportDeliveryFile,type ExportDeliveryEnvelope,type ExportDeliveryRow} from './auditExportDeliveryContract';
const headers=new WeakSet<ExportDeliveryHeader>(),files=new WeakSet<ExportDeliveryFile>();
function sameIdentity(left:ExportDeliveryIdentity,right:ExportDeliveryIdentity){return Object.keys(deliveryIdentity.shape).every(key=>left[key as keyof ExportDeliveryIdentity]===right[key as keyof ExportDeliveryIdentity]);}
/** Pure background generator. Storage publication separately proves the issued lease and current authority. */
export async function* exportDeliveryRows(bundle:AuditEvidenceBundle,identity:ExportDeliveryIdentity,permissions:string[],options?:{signal?:AbortSignal;deadlineAt?:number}):AsyncGenerator<ExportDeliveryRow>{
 const check=indexBudget(options);check();const expected=deliveryIdentity.parse(detachIndexValue(identity)),provided=detachIndexValue(permissions);
 const material=await prepareDelivery(bundle,expected,provided,check),crypto=indexCryptography();
 const header=deliveryHeader.parse({...expected,version:1,fileCount:material.files.length,totalBytes:material.totalBytes,permissions:material.permissions});
 const protectedHeader=crypto.seal('export-header',header);check();yield{kind:'header',header:detachIndexValue(header),envelope:protectedHeader};
 for(let ordinal=0;ordinal<material.files.length;ordinal++){
  check();const {bytes,...metadata}=material.files[ordinal]!;
  const file=deliveryFile.parse({...expected,...metadata,ordinal,chunkCount:Math.ceil(bytes.length/limits.chunkBytes)});
  yield{kind:'file',file:detachIndexValue(file),envelope:crypto.seal('export-file',file)};
  for(let chunkOrdinal=0;chunkOrdinal<file.chunkCount;chunkOrdinal++){
   check();const chunk=bytes.subarray(chunkOrdinal*limits.chunkBytes,(chunkOrdinal+1)*limits.chunkBytes);
   const envelope=crypto.seal('export-chunk',{file,chunkOrdinal,sha256:indexHash(chunk),bytesBase64:Buffer.from(chunk).toString('base64')});
   yield{kind:'chunk',fileOrdinal:ordinal,chunkOrdinal,envelope};
   await setImmediate();check();
  }
  // Release the private plaintext file after its final chunk; output ciphertext is never accumulated here.
  material.files[ordinal]!.bytes=new Uint8Array();
 }
 check();
}
export function openExportDeliveryHeader(envelope:ExportDeliveryEnvelope,expected:ExportDeliveryIdentity):ExportDeliveryHeader{
 const identity=deliveryIdentity.parse(detachIndexValue(expected)),header=deliveryHeader.parse(indexCryptography().open('export-header',envelope));
 if(!sameIdentity(header,identity))throw new Error('Export header identity changed');
 Object.freeze(header.permissions);Object.freeze(header);headers.add(header);return header;
}
export function openExportDeliveryFile(envelope:ExportDeliveryEnvelope,header:ExportDeliveryHeader,ordinal:number):ExportDeliveryFile{
 if(!headers.has(header)||!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=header.fileCount)throw new Error('Verified export header and ordinal required');
 const file=deliveryFile.parse(indexCryptography().open('export-file',envelope));
 if(!sameIdentity(file,header)||file.ordinal!==ordinal||file.byteLength>header.totalBytes)throw new Error('Export file identity changed');
 Object.freeze(file);files.add(file);return file;
}
export function openExportDeliveryChunk(envelope:ExportDeliveryEnvelope,file:ExportDeliveryFile,chunkOrdinal:number):Uint8Array{
 if(!files.has(file)||!Number.isSafeInteger(chunkOrdinal)||chunkOrdinal<0||chunkOrdinal>=file.chunkCount)throw new Error('Verified export file and chunk ordinal required');
 const chunk=deliveryChunk.parse(indexCryptography().open('export-chunk',envelope));
 if(canonicalJson(chunk.file)!==canonicalJson(file)||chunk.chunkOrdinal!==chunkOrdinal)throw new Error('Export chunk identity changed');
 const bytes=Buffer.from(chunk.bytesBase64,'base64'),length=Math.min(limits.chunkBytes,file.byteLength-chunkOrdinal*limits.chunkBytes);
 if(bytes.length!==length||bytes.toString('base64')!==chunk.bytesBase64||indexHash(bytes)!==chunk.sha256)throw new Error('Export chunk bytes changed');
 return new Uint8Array(bytes);
}
