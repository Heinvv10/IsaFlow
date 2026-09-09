import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {expect,it} from 'vitest';
import {readBankAttachmentStorageEvidence} from '@/modules/accounting/services/controls/bankAttachmentEvidenceStorage';
const bytes=Buffer.from('%PDF-1.7\nSynthetic retained attachment');
const input={fileUrl:`data:application/pdf;base64,${bytes.toString('base64')}`,recordedSize:bytes.length};
it('decodes the actual writer format with computed hash and unknown historical authenticity',async()=>{
 const result=await readBankAttachmentStorageEvidence(input);
 expect(result).toMatchObject({status:'available',sha256:createHash('sha256').update(bytes).digest('hex'),recordedHashVerified:false,mediaType:'application/pdf'});
 if(result.status==='available')expect(Buffer.from(result.bytes)).toEqual(bytes);
});
it('never fetches external URLs even when an actual HTTP endpoint responds',async()=>{
 let requests=0;const server=createServer((_req,res)=>{requests++;res.end(bytes);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const address=server.address();if(!address||typeof address==='string')throw new Error('Local listener absent');
  expect(await readBankAttachmentStorageEvidence({...input,fileUrl:`http://127.0.0.1:${address.port}/attachment`})).toEqual({status:'unavailable',reason:'unsupported_attachment_source'});
  expect(requests).toBe(0);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
it('reports malformed, empty and changed-size inline bytes without inventing evidence',async()=>{
 for(const fileUrl of ['data:application/pdf;base64,!!!!','data:application/pdf;base64,','data:application/pdf;base64,Zh=='])
  expect(await readBankAttachmentStorageEvidence({...input,fileUrl})).toMatchObject({status:'unavailable'});
 expect(await readBankAttachmentStorageEvidence({...input,recordedSize:bytes.length+1})).toEqual({status:'unavailable',reason:'attachment_size_mismatch'});
 expect(await readBankAttachmentStorageEvidence({...input,fileUrl:null})).toEqual({status:'unavailable',reason:'attachment_bytes_missing'});
});
it('enforces actual2MiB limit and external cancellation',async()=>{
 const large=Buffer.alloc(2*1024*1024+1);
 expect(await readBankAttachmentStorageEvidence({fileUrl:`data:application/pdf;base64,${large.toString('base64')}`,recordedSize:null})).toMatchObject({status:'unavailable',reason:'attachment_resource_limit'});
 const controller=new AbortController();controller.abort(new Error('Capture cancelled'));
 await expect(readBankAttachmentStorageEvidence(input,controller.signal)).rejects.toThrow('Capture cancelled');
});
it('rejects accessor descriptors without invoking them',async()=>{
 let calls=0;const supplied={...input};Object.defineProperty(supplied,'fileUrl',{enumerable:true,get(){calls++;return input.fileUrl;}});
 await expect(readBankAttachmentStorageEvidence(supplied)).rejects.toThrow();expect(calls).toBe(0);
});
it('retains same-size changed bytes as a distinct capture without claiming recorded authenticity',async()=>{
 const result=await readBankAttachmentStorageEvidence({...input,fileUrl:`data:application/pdf;base64,${Buffer.alloc(bytes.length,65).toString('base64')}`});
 expect(result).toMatchObject({status:'available',recordedHashVerified:false});
 if(result.status==='available')expect(result.sha256).not.toBe(createHash('sha256').update(bytes).digest('hex'));
});

it('bounds retained media metadata as well as decoded byte size',async()=>{
 expect(await readBankAttachmentStorageEvidence({...input,fileUrl:`data:application/${'x'.repeat(300)};base64,${bytes.toString('base64')}`})).toMatchObject({status:'unavailable',reason:'attachment_encoding_invalid'});
});
