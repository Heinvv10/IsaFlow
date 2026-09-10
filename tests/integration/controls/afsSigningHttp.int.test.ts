import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';

// Outbound mail is the only boundary replaced besides the Signum HTTP API, which is answered
// below at the network edge: every route, guard, lock and row is real.
vi.mock('@/modules/accounting/services/afs/portalNotificationService',()=>({notifySigningRequested:vi.fn(async()=>undefined),notifyDocumentSignedOff:vi.fn(async()=>undefined)}));

/**
 * A document out for signature is signed as it stood when it was sent. While signatures are
 * pending no section may change; the webhook signs off only the content that was sent, refuses
 * otherwise with a recorded reason, and never moves a filed document backwards.
 */
let h:Awaited<ReturnType<typeof afsSectionHttpFixture>>;
const realFetch=globalThis.fetch;
const PDF=Buffer.from('%PDF-synthetic signed');
beforeAll(async()=>{
 h=await afsSectionHttpFixture();
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(!url.startsWith(process.env.SIGNUM_API_URL!))return realFetch(input,init);
  if(url.endsWith('/documents/from-html'))return new Response(JSON.stringify({documentId:`signum-${randomUUID()}`,signers:[]}),{status:200,headers:{'content-type':'application/json'}});
  if(url.endsWith('/download'))return new Response(PDF,{status:200});
  return new Response('unexpected Signum call',{status:500});
 });
},30000);
afterAll(async()=>{vi.restoreAllMocks();await h?.close();});

/** A partner_review document with signed-off sections, rendered HTML and a director to sign. */
async function readyToSign(sectionStatus='signed_off'){
 const doc=await h.document('partner_review');
 const a=await h.section(doc,{status:sectionStatus}),b=await h.section(doc,{status:sectionStatus});
 const html=`${h.storage}/afs-html/${h.f.companyA}/${doc}.html`;
 await mkdir(dirname(html),{recursive:true});await writeFile(html,'<html><body>Synthetic AFS</body></html>');
 const contact=randomUUID();
 await h.pool.query("INSERT INTO portal_contacts(id,company_id,name,email,role) VALUES($1,$2,'Synthetic Director',$3,'director')",[contact,h.f.companyA,`${contact}@forensic.invalid`]);
 return{doc,sections:[a,b],contact};
}
async function send(doc:string,contact:string){
 const res=await h.request('POST',`/api/accounting/afs/${doc}/send-for-signing`,{signerContactIds:[contact]});
 expect(res.status,JSON.stringify(res.body)).toBe(200);
 return String((await h.readDocument(doc)).signum_document_id);
}

describe('send for signing',()=>{
 it('records a fingerprint of the content it sends',async()=>{
  const {doc,contact}=await readyToSign();
  await send(doc,contact);
  expect((await h.readDocument(doc)).signing_content_fingerprint,'nothing records what was sent').toMatch(/^[0-9a-f]{64}$/);
 });
 it('refuses to send while a mandatory section is not signed off',async()=>{
  const {doc,contact}=await readyToSign('reviewed');
  const res=await h.request('POST',`/api/accounting/afs/${doc}/send-for-signing`,{signerContactIds:[contact]});
  expect(res.status,JSON.stringify(res.body)).toBe(409);
  expect((await h.readDocument(doc)).signing_requested_at).toBeNull();
 });
});

describe('while signatures are pending',()=>{
 it('no section of the document takes a write',async()=>{
  const {doc,sections:[a],contact}=await readyToSign();
  await send(doc,contact);
  const before=await h.read(a!);
  const writes:[string,string,unknown][]=[['PUT','overrides',{overrides:{title:'Late',blocks:[]}}],['POST','suppress',{suppress:true,reason:'nil'}],
   ['POST','comments',{body:'Late'}],['POST','review',undefined],['PUT','ai-narrative',undefined]];
  for(const [method,route,body] of writes)
   expect((await h.request(method,h.sectionPath(doc,a!,route),body)).status,`${route} while out for signature`).toBe(409);
  expect((await h.request('PUT',`/api/accounting/afs/${doc}/sections/reorder`,{sections:[{id:a,newSortOrder:5}]})).status).toBe(409);
  expect(await h.read(a!)).toEqual(before);
 });
});

describe('the signature webhook',()=>{
 it('signs off the content that was sent and stores the signed PDF',async()=>{
  const {doc,contact}=await readyToSign();
  const signum=await send(doc,contact);
  expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  const row=await h.readDocument(doc);
  expect(row.status).toBe('signed_off');
  expect(await readFile(String(row.signed_pdf_path))).toEqual(PDF);
 });

 it.each([
  ['content changed since it was sent',`UPDATE afs_sections SET content='{"title":"Changed","blocks":[]}'::jsonb WHERE company_id=$1 AND id=$2`],
  ['a section is no longer signed off',`UPDATE afs_sections SET status='reviewed',signed_off_by=NULL,signed_off_at=NULL WHERE company_id=$1 AND id=$2`],
 ])('refuses to sign off when %s, records why, and hands the document back',async(_why,change)=>{
  const {doc,sections:[a],contact}=await readyToSign();
  const signum=await send(doc,contact);
  await h.pool.query(change,[h.f.companyA,a]);
  expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  const row=await h.readDocument(doc);
  expect(row.status,'signed off content nobody signed').toBe('partner_review');
  expect(row.signing_refused_reason).toBeTruthy();
  expect({requested:row.signing_requested_at,signum:row.signum_document_id,fingerprint:row.signing_content_fingerprint}).toEqual({requested:null,signum:null,fingerprint:null});
  expect(row.signed_pdf_path).toBeNull();
 });

 it.each(['filed','signed_off'])('never moves a %s document, whatever the event',async status=>{
  const {doc,contact}=await readyToSign();
  const signum=await send(doc,contact);
  await h.pool.query('UPDATE afs_documents SET status=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,doc,status]);
  const before=await h.readDocument(doc);
  for(const event of ['document.signed','document.cancelled'])expect((await h.webhook({documentId:signum,event})).status).toBe(200);
  expect(await h.readDocument(doc)).toEqual(before);
 });
});
