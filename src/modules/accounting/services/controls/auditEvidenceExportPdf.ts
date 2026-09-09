import PDFDocument from 'pdfkit';
import {canonicalJson} from './canonical';
import type {AuditSnapshotData} from './auditSnapshotSeal';
import {EXPORT_LIMITS,exportExecution,type ExportOptions} from './auditEvidenceExportMaterial';
/** Built-in PDF font has limited glyphs: JSON Unicode escapes preserve every original code unit. */
function asciiJson(value:unknown){return canonicalJson(value).replace(/[^\x20-\x7e]/g,char=>`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`);}
export async function renderEvidencePdf(snapshot:AuditSnapshotData,canonicalHash:string,deadline:number,options:ExportOptions={}):Promise<Uint8Array>{
 const execution=exportExecution({signal:options.signal,deadlineAt:Math.min(deadline,options.deadlineAt??deadline)});execution.check();
 return new Promise((resolve,reject)=>{
  const doc=new PDFDocument({autoFirstPage:false,compress:true,info:{Title:'Retained audit evidence',Subject:canonicalHash}});
  const chunks:Buffer[]=[];let bytes=0,pages=0,y=0,lines=0,failed=false;
  const cleanup=()=>execution.signal?.removeEventListener('abort',abort);
  const fail=(error:unknown)=>{if(failed)return;failed=true;cleanup();doc.destroy();reject(error);};
  const abort=()=>fail(execution.signal?.reason??new Error('Export cancelled'));
  execution.signal?.addEventListener('abort',abort,{once:true});
  doc.on('data',(chunk:Buffer)=>{if(failed)return;bytes+=chunk.length;if(bytes>EXPORT_LIMITS.pdfBytes)fail(new Error('PDF resource limit'));else chunks.push(chunk);});
  doc.on('error',fail);doc.on('end',()=>{cleanup();if(!failed){try{execution.check();resolve(new Uint8Array(Buffer.concat(chunks)));}catch(error){fail(error);}}});
  async function paragraph(text:string){
   for(let offset=0;offset<text.length;offset+=110){
    if(failed)throw new Error('PDF rendering aborted');
    execution.check();
    if(!pages||y>780){
     if(++pages>EXPORT_LIMITS.pdfPages)throw new Error('PDF page resource limit');
     doc.addPage({size:'A4',margin:40});doc.font('Courier').fontSize(7);y=40;
    }
    doc.text(text.slice(offset,offset+110),40,y,{lineBreak:false});y+=10;
    if(++lines%256===0)await execution.checkpoint();
   }
  }
  void(async()=>{
   await paragraph('Retained audit evidence. JSON escapes preserve original Unicode; snapshot.json is authoritative.');
   await paragraph(`Canonical snapshot SHA256: ${canonicalHash}`);
   const {records,checks,...metadata}=snapshot;
   await paragraph(`Metadata ${asciiJson(metadata)}`);
   for(let index=0;index<records.length;index++)await paragraph(`Record ${index+1} ${asciiJson(records[index])}`);
   for(let index=0;index<checks.length;index++)await paragraph(`Check ${index+1} ${asciiJson(checks[index])}`);
   execution.check();doc.end();
  })().catch(error=>fail(error instanceof Error?error:new Error('PDF rendering failed')));
 });
}
