import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';
import {renderDocumentHtml} from '@/modules/accounting/services/afs/pdfExportService';

// Outbound mail is the only boundary replaced besides the Signum HTTP API, which is answered
// below at the network edge: every route, guard, lock and row is real.
vi.mock('@/modules/accounting/services/afs/portalNotificationService',()=>({notifySigningRequested:vi.fn(async()=>undefined),notifyDocumentSignedOff:vi.fn(async()=>undefined)}));
// The real renderer, wrapped so one test can make it fail the way a broken template would.
vi.mock('@/modules/accounting/services/afs/pdfExportService',async importOriginal=>{
 const real=await importOriginal<typeof import('@/modules/accounting/services/afs/pdfExportService')>();
 return{...real,renderDocumentHtml:vi.fn(real.renderDocumentHtml)};
});

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
/** Set by the test that proves a failed provider download is recorded as one. */
let downloadFails=false;
beforeAll(async()=>{
 h=await afsSectionHttpFixture();
 vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(!url.startsWith(process.env.SIGNUM_API_URL!))return realFetch(input,init);
  if(url.endsWith('/documents/from-html')){
   posted.push(JSON.parse(String(init?.body)).html as string);
   return new Response(JSON.stringify({documentId:`signum-${randomUUID()}`,signers:[]}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url.endsWith('/download'))return downloadFails?new Response('unavailable',{status:503}):new Response(PDF,{status:200});
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

 it('refuses to send when the statements cannot be rendered, and says what failed',async()=>{
  const {doc,contact}=await readyToSign();
  vi.mocked(renderDocumentHtml).mockRejectedValueOnce(new Error('Synthetic renderer failure'));
  posted.length=0;
  const res=await h.request('POST',`/api/accounting/afs/${doc}/send-for-signing`,{signerContactIds:[contact]});
  expect(res.status,JSON.stringify(res.body)).toBe(409);
  expect(res.body.error?.message,'the refusal did not name what failed').toContain('Synthetic renderer failure');
  expect(posted,'the document went to the signatories anyway').toHaveLength(0);
  expect(await h.readDocument(doc)).toMatchObject({status:'partner_review',signing_requested_at:null,signum_document_id:null});
 });

 it('sends for a company with no brand profile of its own, on the documented default',async()=>{
  const {doc,contact}=await readyToSign();
  await h.pool.query('DELETE FROM brand_profiles WHERE company_id=$1',[h.f.companyA]);
  try{
   await send(doc,contact);
   expect((await h.readDocument(doc)).signing_content_fingerprint).toMatch(/^[0-9a-f]{64}$/);
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
 ])('refuses to sign off when %s, records why, and hands the document back',async(why,change)=>{
  const {doc,sections:[a],contact}=await readyToSign();
  const signum=await send(doc,contact);
  await h.pool.query(change,[h.f.companyA,a]);
  expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  const row=await h.readDocument(doc);
  expect(row.status,'signed off content nobody signed').toBe('partner_review');
  expect(row.signing_refused_reason).toBeTruthy();
  if(why.startsWith('content'))expect(String(row.signing_refused_reason)).toMatch(/section/i);
  // The signatories DID sign: the artifact is kept, out of the document's own path, and the
  // refusal is visible on the document a user opens.
  const quarantined=await readdir(`${h.storage}/afs-signed-quarantine/${h.f.companyA}`).catch(()=>[] as string[]);
  expect(quarantined.some(name=>name.startsWith(doc)),'the signed PDF was discarded').toBe(true);
  expect(String(row.signing_refused_reason),'the record does not say the copy was kept').toMatch(/has been kept/i);
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

describe('the migrations that stamp documents already out for signature',()=>{
 const statement=async(file:string)=>{
  const migration=await readFile(`scripts/migrations/sql/${file}`,'utf-8');
  const found=migration.split(/;\s*\n/).find(part=>part.includes('UPDATE afs_documents'));
  expect(found,`${file} carries no backfill`).toBeTruthy();
  return `${found};`;
 };
 /** The state 681 leaves: out for signature, with no record of what was sent. */
 async function sentBeforeTheFingerprint(){
  const {doc,sections,contact}=await readyToSign();
  const signum=await send(doc,contact);
  await h.pool.query('UPDATE afs_documents SET signing_content_fingerprint=NULL,signing_payload_sha256=NULL,signing_input_digests=NULL WHERE company_id=$1 AND id=$2',[h.f.companyA,doc]);
  return{doc,sections,signum};
 }
 const change=(id:string)=>h.pool.query(`UPDATE afs_sections SET content='{"title":"Changed","blocks":[]}'::jsonb WHERE company_id=$1 AND id=$2`,[h.f.companyA,id]);

 it('re-stamps a document whose content is unchanged since the send, so its signature is accepted',async()=>{
  const {doc,signum}=await sentBeforeTheFingerprint();
  await h.pool.query(await statement('682_afs_signing_payload_fingerprint.sql'));
  await h.pool.query(await statement('683_afs_pack_delivery_withheld.sql'));
  expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  expect((await h.readDocument(doc)).status,'a signature already in flight was refused').toBe('signed_off');
 });

 it('leaves the old stamp on a document whose content changed after the send, so its signature is refused',async()=>{
  const {doc,sections:[a],signum}=await sentBeforeTheFingerprint();
  await h.pool.query(await statement('682_afs_signing_payload_fingerprint.sql'));
  await change(a!);
  await h.pool.query(await statement('683_afs_pack_delivery_withheld.sql'));
  expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  expect((await h.readDocument(doc)).status,'683 laundered a post-send change').toBe('partner_review');
 });

 it('does not launder a change made after go-live when it is run a second time',async()=>{
  const {doc,sections:[a],signum}=await sentBeforeTheFingerprint();
  await h.pool.query(await statement('682_afs_signing_payload_fingerprint.sql'));
  await h.pool.query(await statement('683_afs_pack_delivery_withheld.sql'));
  const stamped=(await h.readDocument(doc)).signing_content_fingerprint;
  await change(a!);
  await h.pool.query(await statement('682_afs_signing_payload_fingerprint.sql'));
  await h.pool.query(await statement('683_afs_pack_delivery_withheld.sql'));
  expect((await h.readDocument(doc)).signing_content_fingerprint,'a re-run re-stamped a changed document').toBe(stamped);
  expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  expect((await h.readDocument(doc)).status).toBe('partner_review');
 });
});

describe('the fingerprint covers every input the statements are rendered from',()=>{
 it.each([
  ['the registered company name',"UPDATE companies SET name='Renamed After Signing' WHERE id=$1",/registered company/i],
  ['the registration number',"UPDATE companies SET registration_number='2099/123456/07' WHERE id=$1",/registered company/i],
  ['the fiscal year on the document',"UPDATE afs_documents SET fiscal_year=2099 WHERE company_id=$1 AND id=$2",/document settings/i],
  ['the reporting framework',"UPDATE afs_documents SET reporting_framework='full_ifrs' WHERE company_id=$1 AND id=$2",/document settings/i],
  ['the firm branding',"UPDATE brand_profiles SET primary_colour='#abcdef' WHERE company_id=$1",/branding/i],
 ])('refuses the signature when %s changed after the send, and names that input',async(_what,change,named)=>{
  const {doc,contact}=await readyToSign();
  const signum=await send(doc,contact);
  const before=(await h.pool.query('SELECT name,registration_number FROM companies WHERE id=$1',[h.f.companyA])).rows[0];
  try{
   await h.pool.query(change,change.includes('afs_documents')?[h.f.companyA,doc]:[h.f.companyA]);
   expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
   const row=await h.readDocument(doc);
   expect(row.status,'the document was signed off over a render nobody saw').toBe('partner_review');
   expect(String(row.signing_refused_reason),'the refusal sends the operator to the wrong input').toMatch(named);
   expect(String(row.signing_refused_reason),'the refusal blamed sections nobody touched').not.toMatch(/section content/i);
  }finally{
   await h.pool.query('UPDATE companies SET name=$2,registration_number=$3 WHERE id=$1',[h.f.companyA,before.name,before.registration_number]);
   await h.pool.query("UPDATE brand_profiles SET primary_colour='#123456' WHERE company_id=$1",[h.f.companyA]);
  }
 });

 it.each([
  // concat_ws drops a NULL outright, so a cleared field and its neighbour's text can trade places:
  ['a NULL registration',['Acme','1998/012345/07'],['Acme|1998/012345/07',null]],
  // and it has no escaping, so the separator can move between two non-empty fields:
  ['a shifted separator',['Acme|1998','012345/07'],['Acme','1998|012345/07']],
 ] as const)('cannot be fooled by moving text between two fields (%s)',async(_case,sent,changed)=>{
  const before=(await h.pool.query('SELECT name,registration_number FROM companies WHERE id=$1',[h.f.companyA])).rows[0];
  await h.pool.query('UPDATE companies SET name=$2,registration_number=$3 WHERE id=$1',[h.f.companyA,...sent]);
  try{
   const {doc,contact}=await readyToSign();
   const signum=await send(doc,contact);
   await h.pool.query('UPDATE companies SET name=$2,registration_number=$3 WHERE id=$1',[h.f.companyA,...changed]);
   expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
   expect((await h.readDocument(doc)).status,'two different registrations hashed the same').toBe('partner_review');
  }finally{
   await h.pool.query('UPDATE companies SET name=$2,registration_number=$3 WHERE id=$1',[h.f.companyA,before.name,before.registration_number]);
  }
 });

 it('refuses when a company that sent on the default branding saves a profile before the signature arrives',async()=>{
  const {doc,contact}=await readyToSign();
  await h.pool.query('DELETE FROM brand_profiles WHERE company_id=$1',[h.f.companyA]);
  try{
   const signum=await send(doc,contact);
   await h.brandProfile();
   expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
   const row=await h.readDocument(doc);
   expect(row.status,'the statements were signed on branding they no longer carry').toBe('partner_review');
   expect(String(row.signing_refused_reason)).toMatch(/branding/i);
  }finally{await h.brandProfile();}
 });
});

describe('editing the inputs of a document out for signature',()=>{
 it('is allowed, and each write path warns which signature it will invalidate',async()=>{
  const {doc,contact}=await readyToSign();
  await send(doc,contact);
  const brand=await h.request('PUT','/api/accounting/afs/brand-profile',{primaryColour:'#123456',secondaryColour:'#654321',fontFamily:'professional',coverStyle:'classic'});
  expect(brand.status,JSON.stringify(brand.body)).toBe(200);
  expect(JSON.stringify(brand.body.data?.warnings),'the branding change gave no warning').toContain(doc);
  const company=await h.request('PUT','/api/accounting/companies',{id:h.f.companyA,registrationNumber:'2024/000001/07'});
  expect(company.status,JSON.stringify(company.body)).toBe(200);
  expect(JSON.stringify(company.body.data?.warnings),'the company change gave no warning').toContain(doc);
 });
});

describe('what the refusal record claims',()=>{
 it('says the signed copy could not be retrieved when the provider download fails, and names no server path',async()=>{
  const {doc,sections:[a],contact}=await readyToSign();
  const signum=await send(doc,contact);
  await h.pool.query(`UPDATE afs_sections SET content='{"title":"Changed","blocks":[]}'::jsonb WHERE company_id=$1 AND id=$2`,[h.f.companyA,a]);
  downloadFails=true;
  try{
   expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  }finally{downloadFails=false;}
  const reason=String((await h.readDocument(doc)).signing_refused_reason);
  expect(reason,'the record claims an artifact that was never written').not.toContain('quarantined at');
  expect(reason).toMatch(/could not be retrieved/i);
  expect(reason,'the server filesystem layout is shown to users').not.toContain(h.storage);
 });

 it('clears the record of what was sent when the request is cancelled',async()=>{
  const {doc,contact}=await readyToSign();
  const signum=await send(doc,contact);
  expect((await h.webhook({documentId:signum,event:'document.cancelled'})).status).toBe(200);
  const row=await h.readDocument(doc);
  expect({fingerprint:row.signing_content_fingerprint,payload:row.signing_payload_sha256},'a cancelled request left the record of what was sent behind')
   .toEqual({fingerprint:null,payload:null});
 });
});
