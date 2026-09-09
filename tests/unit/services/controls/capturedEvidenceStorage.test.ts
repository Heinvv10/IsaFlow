import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createHash} from 'node:crypto';
import {readCapturedStorageEvidence} from '@/modules/accounting/services/controls/capturedEvidenceStorage';
const companyId='a1111111-1111-4111-8111-111111111111',documentId='b1111111-1111-4111-8111-111111111111';
const bytes=Buffer.from('Synthetic original statement'),hash=createHash('sha256').update(bytes).digest('hex');
const input=()=>({companyId,documentId,bucket:'captured-documents',path:`${companyId}/${documentId}`,recordedHash:hash,recordedSize:bytes.length,mediaType:'application/pdf'});
let server:Server,mode='valid',requests=0,observedPath='',observedAuthorization='';
beforeAll(async()=>{
 server=createServer((request,response)=>{
  requests++;observedPath=request.url??'';observedAuthorization=request.headers.authorization??'';
  if(mode==='hold')return;
  if(mode==='redirect'){response.writeHead(302,{location:'http://127.0.0.1:1/secret'});response.end();return;}
  if(mode==='missing'){response.writeHead(404);response.end();return;}
  if(mode==='large'){response.writeHead(200);response.end(Buffer.alloc(10*1024*1024+1));return;}
  response.writeHead(200);response.end(mode==='changed'?Buffer.from('changed original'):bytes);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic HTTP listener unavailable');
 vi.stubEnv('SUPABASE_URL',`http://127.0.0.1:${address.port}`);
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','synthetic-local-only-key');vi.stubEnv('SUPABASE_CAPTURED_DOCS_BUCKET','captured-documents');
});
afterEach(()=>{mode='valid';});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));vi.unstubAllEnvs();});
it('downloads actual object bytes from the configured store and verifies recorded hash and length',async()=>{
 const result=await readCapturedStorageEvidence(input());
 expect(Buffer.from(result!.bytes)).toEqual(bytes);expect(result).toMatchObject({sha256:hash,recordedHashVerified:true});
 expect(observedPath).toBe(`/storage/v1/object/captured-documents/${companyId}/${documentId}`);
 expect(observedAuthorization).toBe('Bearer synthetic-local-only-key');
});
it('rejects foreign object paths and buckets before making a request',async()=>{
 const before=requests;
 await expect(readCapturedStorageEvidence({...input(),path:`${documentId}/${companyId}`})).rejects.toThrow(/namespace/i);
 await expect(readCapturedStorageEvidence({...input(),bucket:'another-bucket'})).rejects.toThrow(/namespace/i);
 expect(requests).toBe(before);
});
it('refuses changed bytes and a changed recorded size',async()=>{
 mode='changed';await expect(readCapturedStorageEvidence(input())).rejects.toThrow(/changed/i);
 mode='valid';await expect(readCapturedStorageEvidence({...input(),recordedSize:bytes.length+1})).rejects.toThrow(/changed/i);
});
it('retains missing historical hash as unverified, without inventing recorded authenticity',async()=>{
 const result=await readCapturedStorageEvidence({...input(),recordedHash:null,recordedSize:null});
 expect(result).toMatchObject({sha256:hash,recordedHashVerified:false});expect(Buffer.from(result!.bytes)).toEqual(bytes);
});
it('returns missing for a real storage404 and never follows a redirect',async()=>{
 mode='missing';expect(await readCapturedStorageEvidence(input())).toBeNull();
 mode='redirect';await expect(readCapturedStorageEvidence(input())).rejects.toThrow(/storage/i);
});
it('bounds actual chunked response bytes without trusting Content-Length',async()=>{
 mode='large';await expect(readCapturedStorageEvidence({...input(),recordedSize:null})).rejects.toThrow(/resource limit/i);
});
it('cancels an actual pending storage request when the caller aborts',async()=>{
 mode='hold';const controller=new AbortController();
 const pending=readCapturedStorageEvidence(input(),controller.signal);
 const timer=setTimeout(()=>controller.abort(),25);
 try{await expect(pending).rejects.toThrow();}finally{clearTimeout(timer);}
});
it('detaches validated metadata before awaiting storage and never invokes metadata getters',async()=>{
 const mutable=input(),pending=readCapturedStorageEvidence(mutable);mutable.recordedHash='0'.repeat(64);
 expect((await pending)?.sha256).toBe(hash);
 let getterCalls=0;const accessor={...input()};Object.defineProperty(accessor,'path',{enumerable:true,get(){getterCalls++;return `${companyId}/${documentId}`;}});
 await expect(readCapturedStorageEvidence(accessor)).rejects.toThrow();expect(getterCalls).toBe(0);
});
