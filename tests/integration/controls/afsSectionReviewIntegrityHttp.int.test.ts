import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';

// The model call is the only boundary replaced: every route, guard, transaction and row is real.
vi.mock('@/modules/accounting/services/afs/noteAiService',()=>({generateNoteNarrative:vi.fn(async()=>'Synthetic narrative')}));

/**
 * A section's review or sign-off attests to specific content. A write that changes the content
 * must void the attestation, no write may touch a section of a signed-off or filed document, and
 * every write must land on the section of the document the request names.
 */
let h:Awaited<ReturnType<typeof afsSectionHttpFixture>>;
beforeAll(async()=>{h=await afsSectionHttpFixture();},30000);
afterAll(async()=>{await h?.close();});
const overrides={title:'Changed after review',blocks:[{type:'paragraph',text:'Preparer edit'}]};
const attestation=(row:Record<string,unknown>)=>({status:row.status,reviewed_by:row.reviewed_by,reviewed_at:row.reviewed_at,signed_off_by:row.signed_off_by,signed_off_at:row.signed_off_at});
const voided={status:'pending',reviewed_by:null,reviewed_at:null,signed_off_by:null,signed_off_at:null};

describe('a content change voids the review that covered the old content',()=>{
 it.each(['reviewed','signed_off'])('an overrides PUT drops a %s section to pending and clears reviewer and signatory',async status=>{
  const doc=await h.document(),id=await h.section(doc,{status});
  const res=await h.request('PUT',h.sectionPath(doc,id,'overrides'),{overrides});
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  const row=await h.read(id);
  expect(row.overrides).toEqual(overrides);
  expect(attestation(row),'overrides left the prior attestation standing').toEqual(voided);
 });

 it('a preparer who edits a reviewed section can no longer submit the document for review',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'reviewed'});
  expect((await h.request('PUT',h.sectionPath(doc,id,'overrides'),{overrides})).status).toBe(200);
  const submit=await h.request('POST',`/api/accounting/afs/${doc}/submit-for-review`,{});
  expect(submit.status,'submission passed on a review of content that no longer exists').toBe(409);
  expect(submit.body.error?.message).toContain('not yet reviewed');
 });

 it('accepting an AI narrative into a reviewed section voids its review',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'reviewed',aiNarrative:'Accepted narrative'});
  const res=await h.request('PUT',h.sectionPath(doc,id,'ai-narrative'));
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  const row=await h.read(id);
  expect(JSON.stringify(row.overrides)).toContain('Accepted narrative');
  expect(attestation(row),'AI accept left the prior attestation standing').toEqual(voided);
 });

 it('a restore clears reviewer and signatory as well as the status',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'signed_off',history:true});
  const res=await h.request('POST',h.sectionPath(doc,id,'versions'),{version:1});
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  expect(attestation(await h.read(id)),'restore left reviewer or signatory on replaced content').toEqual(voided);
 });

 it('suppressing a reviewed section clears its reviewer',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'reviewed'});
  const res=await h.request('POST',h.sectionPath(doc,id,'suppress'),{suppress:true,reason:'nil'});
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  expect(attestation(await h.read(id)),'suppress left the prior reviewer standing').toEqual(voided);
 });

 it('records the invalidation in the audit log a reviewer reads, and records nothing when there was no review',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'signed_off'});
  expect((await h.request('PUT',h.sectionPath(doc,id,'overrides'),{overrides})).status).toBe(200);
  const rows=await h.audits(id);
  expect(rows,'no audit row recorded the voided review').toHaveLength(1);
  const [row]=rows;
  expect(row).toMatchObject({user_id:h.f.u1.id,action:'update',entity_type:'afs_section'});
  const changes=row!.changes as {fields:{field:string;old:string|null;new:string|null}[];metadata:Record<string,string>};
  expect(changes.fields).toEqual(expect.arrayContaining([
   expect.objectContaining({field:'status',old:'signed_off',new:'pending'}),
   expect.objectContaining({field:'reviewed_by',old:h.f.u2.id,new:null}),
   expect.objectContaining({field:'signed_off_by',old:h.f.u2.id,new:null})]));
  expect(changes.metadata.documentId).toBe(doc);
  expect(changes.metadata.reason).toContain('overrides');
  const pending=await h.section(doc,{status:'pending'});
  expect((await h.request('PUT',h.sectionPath(doc,pending,'overrides'),{overrides})).status).toBe(200);
  expect(await h.audits(pending)).toHaveLength(0);
 });
});

describe('no write touches a section of a signed-off or filed document',()=>{
 const writes:[string,string,string,unknown][]=[
  ['overrides PUT','PUT','overrides',{overrides}],
  ['AI narrative accept','PUT','ai-narrative',undefined],
  ['AI narrative generate','POST','ai-narrative',undefined],
  ['restore','POST','versions',{version:1}],
  ['regenerate','POST','regenerate',{fiscalYear:2024,framework:'ifrs_smes'}],
  ['suppress','POST','suppress',{suppress:true,reason:'nil'}],
 ];
 for(const docStatus of ['signed_off','filed'])for(const [name,method,route,body] of writes)
  it(`refuses ${name} in a ${docStatus} document and leaves the section untouched`,async()=>{
   // A signed-off section refuses suppression on its own, so suppress is proven on a reviewed one.
   const doc=await h.document(docStatus),id=await h.section(doc,{status:route==='suppress'?'reviewed':'signed_off',aiNarrative:'Late narrative',history:true});
   const before=await h.read(id);
   const res=await h.request(method,h.sectionPath(doc,id,route),body);
   expect(res.status,`${name} on a ${docStatus} document: ${JSON.stringify(res.body)}`).toBe(409);
   expect(await h.read(id)).toEqual(before);
  });
});

describe('every write lands on the section of the document the request names',()=>{
 const writes:[string,string,string,unknown][]=[
  ['restore','POST','versions',{version:1}],
  ['overrides PUT','PUT','overrides',{overrides}],
  ['AI narrative accept','PUT','ai-narrative',undefined],
  ['suppress','POST','suppress',{suppress:true,reason:'nil'}],
 ];
 for(const [name,method,route,body] of writes)
  it(`refuses a ${name} addressed through an editable document to a section of a filed one`,async()=>{
   const editable=await h.document(),filed=await h.document('filed');
   const id=await h.section(filed,{status:route==='suppress'?'reviewed':'signed_off',aiNarrative:'Late narrative',history:true});
   const before=await h.read(id);
   const res=await h.request(method,h.sectionPath(editable,id,route),body);
   expect(res.status,`${name} crossed documents: ${JSON.stringify(res.body)}`).toBe(404);
   expect(await h.read(id)).toEqual(before);
  });

 it('does not list the history of a section through another document',async()=>{
  const editable=await h.document(),filed=await h.document('filed');
  const id=await h.section(filed,{status:'signed_off',history:true});
  expect((await h.request('GET',h.sectionPath(editable,id,'versions'))).status).toBe(404);
  expect((await h.request('GET',h.sectionPath(filed,id,'versions'))).status).toBe(200);
 });
});
