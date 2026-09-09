import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createHash} from 'node:crypto';
import {readProcurementStorageEvidence} from '@/modules/accounting/services/controls/procurementEvidenceStorage';
const companyId='a1111111-1111-4111-8111-111111111111',documentId='b1111111-1111-4111-8111-111111111111';
const bytes=Buffer.from('Synthetic original statement'),hash=createHash('sha256').update(bytes).digest('hex');
const input=()=>({companyId,documentId,entityType:'customer_invoice' as const,entityId:documentId,path:`accounting/customer_invoice/${documentId}_statement.pdf`,recordedSize:bytes.length,mediaType:'application/pdf'});
let server:Server,mode='valid',requests=0,observedPath='',observedAuthorization='';
beforeAll(async()=>{
 server=createServer((request,response)=>{
  requests++;observedPath=request.url??'';observedAuthorization=request.headers.authorization??'';
  if(mode==='hold')return;
  if(mode==='redirect'){response.writeHead(302,{location:'http://127.0.0.1:1/secret'});response.end();return;}
  if(mode==='missing'){response.writeHead(404);response.end();return;}
  if(mode==='large'){response.writeHead(200);response.end(Buffer.alloc(20*1024*1024+1));return;}
  response.writeHead(200);response.end(mode==='changed'?Buffer.from('changed original'):bytes);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic HTTP listener unavailable');
 vi.stubEnv('VF_STORAGE_URL',`http://127.0.0.1:${address.port}`);
 
});
afterEach(()=>{mode='valid';});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));vi.unstubAllEnvs();});
it('downloads actual object bytes from the configured store and verifies recorded length without fabricating historical authenticity',async()=>{
 const result=await readProcurementStorageEvidence(input());
 expect(Buffer.from(result!.bytes)).toEqual(bytes);expect(result).toMatchObject({sha256:hash,recordedHashVerified:false});
 expect(observedPath).toBe(`/accounting/customer_invoice/${documentId}_statement.pdf`);
 expect(observedAuthorization).toBe('');
});
it('rejects foreign object paths and parent filename prefixes before making a request',async()=>{
 const before=requests;
 await expect(readProcurementStorageEvidence({...input(),path:`${documentId}/${companyId}`})).rejects.toThrow(/namespace/i);
 await expect(readProcurementStorageEvidence({...input(),path:`accounting/customer_invoice/${companyId}_statement.pdf`})).rejects.toThrow(/namespace/i);
 expect(requests).toBe(before);
});
it('refuses changed bytes and a changed recorded size',async()=>{
 mode='changed';await expect(readProcurementStorageEvidence(input())).rejects.toThrow(/changed/i);
 mode='valid';await expect(readProcurementStorageEvidence({...input(),recordedSize:bytes.length+1})).rejects.toThrow(/changed/i);
});
it('retains missing historical hash as unverified, without inventing recorded authenticity',async()=>{
 const result=await readProcurementStorageEvidence({...input(),recordedSize:null});
 expect(result).toMatchObject({sha256:hash,recordedHashVerified:false});expect(Buffer.from(result!.bytes)).toEqual(bytes);
});
it('returns missing for a real storage404 and never follows a redirect',async()=>{
 mode='missing';expect(await readProcurementStorageEvidence(input())).toBeNull();
 mode='redirect';await expect(readProcurementStorageEvidence(input())).rejects.toThrow(/storage/i);
});
it('bounds actual chunked response bytes without trusting Content-Length',async()=>{
 mode='large';await expect(readProcurementStorageEvidence({...input(),recordedSize:null})).rejects.toThrow(/resource limit/i);
});
it('cancels an actual pending storage request when the caller aborts',async()=>{
 mode='hold';const controller=new AbortController();
 const pending=readProcurementStorageEvidence(input(),controller.signal);
 const timer=setTimeout(()=>controller.abort(),25);
 try{await expect(pending).rejects.toThrow();}finally{clearTimeout(timer);}
});
it('detaches validated metadata before awaiting storage and never invokes metadata getters',async()=>{
 const mutable=input(),pending=readProcurementStorageEvidence(mutable);mutable.path='changed';
 expect((await pending)?.sha256).toBe(hash);
 let getterCalls=0;const accessor={...input()};Object.defineProperty(accessor,'path',{enumerable:true,get(){getterCalls++;return `${companyId}/${documentId}`;}});
 await expect(readProcurementStorageEvidence(accessor)).rejects.toThrow();expect(getterCalls).toBe(0);
});
it('refuses traversal and unsupported server filename rewriting before HTTP',async()=>{
 const before=requests;
 for(const path of [`accounting/customer_invoice/${documentId}_../other.pdf`,`accounting/customer_invoice/${documentId}_%2fother.pdf`,`accounting/customer_invoice/rewrite_${documentId}_file.pdf`]){
  await expect(readProcurementStorageEvidence({...input(),path})).rejects.toThrow(/namespace/i);
 }
 expect(requests).toBe(before);
});
