import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {expect,vi} from 'vitest';
import type {afsSectionHttpFixture} from './afsSectionHttpFixture';

type Fixture=Awaited<ReturnType<typeof afsSectionHttpFixture>>;
export const SIGNED_PDF=Buffer.from('%PDF-synthetic signed');

/**
 * The Signum HTTP API answered at the network edge, plus the steps every signing test repeats.
 * Everything else — routes, guards, locks, rows, the renderer — is real.
 */
export function signingHarness(h:Fixture){
 const realFetch=globalThis.fetch;
 /** The HTML actually posted to Signum, per created document. */
 const posted:string[]=[];
 const state={downloadFails:false};
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(!url.startsWith(process.env.SIGNUM_API_URL!))return realFetch(input,init);
  if(url.endsWith('/documents/from-html')){
   posted.push(JSON.parse(String(init?.body)).html as string);
   return new Response(JSON.stringify({documentId:`signum-${randomUUID()}`,signers:[]}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url.endsWith('/download'))return state.downloadFails?new Response('unavailable',{status:503}):new Response(SIGNED_PDF,{status:200});
  return new Response('unexpected Signum call',{status:500});
 });

 /** A partner_review document with signed-off sections, a stale artifact on disk and a director to sign. */
 async function readyToSign(sectionStatus='signed_off',content?:unknown){
  await h.brandProfile();
  const doc=await h.document('partner_review');
  const a=await h.section(doc,{status:sectionStatus,...(content===undefined?{}:{content})}),b=await h.section(doc,{status:sectionStatus});
  // A stale artifact of unknown age: nothing in the product writes this file, and the send
  // must not sign it.
  const html=`${h.storage}/afs-html/${h.f.companyA}/${doc}.html`;
  await mkdir(dirname(html),{recursive:true});await writeFile(html,'<html><body>STALE ARTIFACT</body></html>');
  const contact=randomUUID();
  await h.pool.query("INSERT INTO portal_contacts(id,company_id,name,email,role) VALUES($1,$2,'Synthetic Director',$3,'director')",[contact,h.f.companyA,`${contact}@forensic.invalid`]);
  return{doc,sections:[a!,b!],contact};
 }
 const sendRequest=(doc:string,contact:string)=>h.request('POST',`/api/accounting/afs/${doc}/send-for-signing`,{signerContactIds:[contact]});
 async function send(doc:string,contact:string){
  const res=await sendRequest(doc,contact);
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  return String((await h.readDocument(doc)).signum_document_id);
 }
 /** Delivers the signature and returns the document as the webhook left it. */
 async function signed(signum:string,doc:string){
  expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  return h.readDocument(doc);
 }
 return{posted,state,readyToSign,sendRequest,send,signed};
}
