import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
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
/** The HTML actually posted to Signum, per created document. */
const posted:string[]=[];
beforeAll(async()=>{
 h=await afsSectionHttpFixture();
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(!url.startsWith(process.env.SIGNUM_API_URL!))return realFetch(input,init);
  if(url.endsWith('/documents/from-html')){
   posted.push(JSON.parse(String(init?.body)).html as string);
   return new Response(JSON.stringify({documentId:`signum-${randomUUID()}`,signers:[]}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url.endsWith('/download'))return new Response(PDF,{status:200});
  return new Response('unexpected Signum call',{status:500});
 });
},30000);
afterAll(async()=>{vi.restoreAllMocks();await h?.close();});

/** A partner_review document with signed-off sections, rendered HTML and a director to sign. */
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

 it('signs the statements rendered from the current rows, never a stale artifact, and records their hash',async()=>{
  const {doc,sections:[a],contact}=await readyToSign('signed_off',{title:'Original note',blocks:[{type:'paragraph',text:'Original figure 111'}]});
  // Edited after that stale artifact was written: the send must carry THIS content.
  await h.pool.query(`UPDATE afs_sections SET content='{"title":"Amended note","blocks":[{"type":"paragraph","text":"Amended figure 222"}]}'::jsonb
   WHERE company_id=$1 AND id=$2`,[h.f.companyA,a]);
  posted.length=0;
  await send(doc,contact);
  const html=posted.at(-1)!;
  expect(html,'a stale artifact was sent for signature').not.toContain('STALE ARTIFACT');
  expect(html).toContain('Amended figure 222');
  expect(html).not.toContain('Original figure 111');
  const row=await h.readDocument(doc);
  expect(row.signing_payload_sha256,'nothing records the bytes that were signed')
   .toBe(createHash('sha256').update(html,'utf8').digest('hex'));
 });

 it('refuses to send when the statements cannot be derived from the current content',async()=>{
  const {doc,contact}=await readyToSign();
  await h.pool.query('DELETE FROM brand_profiles WHERE company_id=$1',[h.f.companyA]);
  posted.length=0;
  try{
   const res=await h.request('POST',`/api/accounting/afs/${doc}/send-for-signing`,{signerContactIds:[contact]});
   expect(res.status,JSON.stringify(res.body)).toBe(409);
   expect(posted,'the document went to the signatories anyway').toHaveLength(0);
   expect(await h.readDocument(doc)).toMatchObject({status:'partner_review',signing_requested_at:null,signum_document_id:null});
  }finally{await h.brandProfile();}
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
  const {doc,sections:[a,b],contact}=await readyToSign();
  await send(doc,contact);
  const before=await h.read(a!);
  const writes:[string,string,unknown][]=[['PUT','overrides',{overrides:{title:'Late',blocks:[]}}],['POST','suppress',{suppress:true,reason:'nil'}],
   ['POST','review',undefined],['PUT','ai-narrative',undefined]];
  for(const [method,route,body] of writes)
   expect((await h.request(method,h.sectionPath(doc,a!,route),body)).status,`${route} while out for signature`).toBe(409);
  // Review correspondence is not part of what is signed, so it stays open: a partner can still
  // raise and clear notes while the signatories work through the document.
  const comment=await h.request('POST',h.sectionPath(doc,a!,'comments'),{body:'Question while signing'});
  expect(comment.status,JSON.stringify(comment.body)).toBe(201);
  expect((await h.request('POST',`${h.sectionPath(doc,a!,'comments')}/${String(comment.body.data?.id)}/resolve`)).status).toBe(200);
  expect((await h.request('PUT',`/api/accounting/afs/${doc}/sections/reorder`,
   {sections:[{id:b,newSortOrder:1},{id:a,newSortOrder:2}]})).status,'reorder while out for signature').toBe(409);
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
  // The signatories DID sign: the artifact is kept, out of the document's own path, and the
  // refusal is visible on the document a user opens.
  const quarantined=await readdir(`${h.storage}/afs-signed-quarantine/${h.f.companyA}`).catch(()=>[] as string[]);
  expect(quarantined.some(name=>name.startsWith(doc)),'the signed PDF was discarded').toBe(true);
  const view=await h.request('GET',`/api/accounting/afs/${doc}`);
  expect(JSON.stringify(view.body.data),'a user cannot see why the signature was refused').toContain(String(row.signing_refused_reason));
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

describe('a document sent before the fingerprint existed',()=>{
 it('is grandfathered by the migration backfill rather than refused on arrival',async()=>{
  const {doc,contact}=await readyToSign();
  const signum=await send(doc,contact);
  // The state migration 681 finds: out for signature, with no record of what was sent.
  await h.pool.query('UPDATE afs_documents SET signing_content_fingerprint=NULL,signing_payload_sha256=NULL WHERE company_id=$1 AND id=$2',[h.f.companyA,doc]);
  const backfill=await readFile('scripts/migrations/sql/682_afs_signing_payload_fingerprint.sql','utf-8');
  const statement=backfill.split(/;\s*\n/).find(part=>part.includes('UPDATE afs_documents'));
  expect(statement,'the migration carries no backfill').toBeTruthy();
  await h.pool.query(`${statement};`);
  expect((await h.readDocument(doc)).signing_content_fingerprint,'the in-flight document was left with no record').toMatch(/^[0-9a-f]{64}$/);
  expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  expect((await h.readDocument(doc)).status,'a signature already in flight was refused').toBe('signed_off');
 });
});
