import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';
import {SIGNED_PDF,signingHarness} from './afsSigningHarness';
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
 * otherwise with a recorded reason, and never moves a filed document backwards. The inputs the
 * fingerprint covers, and races against the send itself, are in afsSigningInputsHttp.
 */
let h:Awaited<ReturnType<typeof afsSectionHttpFixture>>;
let s:ReturnType<typeof signingHarness>;
beforeAll(async()=>{h=await afsSectionHttpFixture();s=signingHarness(h);},30000);
afterAll(async()=>{vi.restoreAllMocks();await h?.close();});
const readyToSign=(...args:Parameters<typeof s.readyToSign>)=>s.readyToSign(...args);
const send=(doc:string,contact:string)=>s.send(doc,contact);

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
  s.posted.length=0;
  await send(doc,contact);
  const html=s.posted.at(-1)!;
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
  s.posted.length=0;
  const res=await h.request('POST',`/api/accounting/afs/${doc}/send-for-signing`,{signerContactIds:[contact]});
  expect(res.status,JSON.stringify(res.body)).toBe(409);
  expect(res.body.error?.message,'the refusal did not name what failed').toContain('Synthetic renderer failure');
  expect(s.posted,'the document went to the signatories anyway').toHaveLength(0);
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
  expect(await readFile(String(row.signed_pdf_path))).toEqual(SIGNED_PDF);
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

describe('a document out for signature with no record of what was sent',()=>{
 it('is refused at the webhook with a reason telling the operator to send it again',async()=>{
  // Not a state the product produces — the send records the fingerprint in the same statement
  // that marks the document out for signature — but hand-made rows exist, and the only safe
  // answer for them is a fresh send.
  const {doc,contact}=await readyToSign();
  const signum=await send(doc,contact);
  await h.pool.query('UPDATE afs_documents SET signing_content_fingerprint=NULL,signing_input_digests=NULL WHERE company_id=$1 AND id=$2',[h.f.companyA,doc]);
  const row=await s.signed(signum,doc);
  expect(row.status,'a signature with no record of what was signed was accepted').toBe('partner_review');
  expect(String(row.signing_refused_reason),'the operator is not told what to do').toMatch(/send it (for signature )?again/i);
 });
});

describe('what the refusal record claims',()=>{
 it('says the signed copy could not be retrieved when the provider download fails, and names no server path',async()=>{
  const {doc,sections:[a],contact}=await readyToSign();
  const signum=await send(doc,contact);
  await h.pool.query(`UPDATE afs_sections SET content='{"title":"Changed","blocks":[]}'::jsonb WHERE company_id=$1 AND id=$2`,[h.f.companyA,a]);
  s.state.downloadFails=true;
  try{
   expect((await h.webhook({documentId:signum,event:'document.signed'})).status).toBe(200);
  }finally{s.state.downloadFails=false;}
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
