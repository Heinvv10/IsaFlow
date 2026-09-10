import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';
import {generateNoteNarrative} from '@/modules/accounting/services/afs/noteAiService';

// The model call is the only boundary replaced: every route, guard, lock and row is real.
vi.mock('@/modules/accounting/services/afs/noteAiService',()=>({generateNoteNarrative:vi.fn()}));

/**
 * The section writes beyond content edits: AI narrative generation, regeneration, reordering and
 * review comments. Each is bound to the document the URL names and refused on a locked document.
 */
let h:Awaited<ReturnType<typeof afsSectionHttpFixture>>;
const aiType=`synthetic_ai_${randomUUID().slice(0,8)}`;
beforeAll(async()=>{
 h=await afsSectionHttpFixture();
 // note_templates is a global registry; this row's section type exists only in this file.
 await h.pool.query("INSERT INTO note_templates(section_type,framework,title,ai_prompt_template,is_mandatory) VALUES($1,'both','Synthetic AI note','Explain {tables} for {companyName}',false)",[aiType]);
},30000);
afterAll(async()=>{await h?.pool.query('DELETE FROM note_templates WHERE section_type=$1',[aiType]);await h?.close();});
beforeEach(()=>{vi.mocked(generateNoteNarrative).mockReset();vi.mocked(generateNoteNarrative).mockResolvedValue('Synthetic narrative');});
const table={title:'Note',blocks:[{type:'table',headers:['Item'],rows:[['1']]}]};
const attestation=(row:Record<string,unknown>)=>({status:row.status,reviewed_by:row.reviewed_by,signed_off_by:row.signed_off_by});

describe('AI narrative generation',()=>{
 it('generates and stores a narrative for a section of this document',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'auto_generated',sectionType:aiType,content:table});
  const res=await h.request('POST',h.sectionPath(doc,id,'ai-narrative'));
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  expect(res.body.data?.narrative).toBe('Synthetic narrative');
  expect((await h.read(id)).ai_narrative).toBe('Synthetic narrative');
  expect(vi.mocked(generateNoteNarrative).mock.calls[0]?.[3]).toMatchObject({framework:'ifrs_smes'});
 });

 it('voids the review of a section whose narrative is what the portal shows, and only then',async()=>{
  const doc=await h.document();
  const shown=await h.section(doc,{status:'reviewed',sectionType:aiType,content:null});
  expect((await h.request('POST',h.sectionPath(doc,shown,'ai-narrative'))).status).toBe(200);
  expect(attestation(await h.read(shown)),'a displayed narrative replaced reviewed content').toEqual({status:'pending',reviewed_by:null,signed_off_by:null});
  expect(await h.audits(shown)).toHaveLength(1);
  const other=await h.document(),hidden=await h.section(other,{status:'reviewed',sectionType:aiType,content:table});
  expect((await h.request('POST',h.sectionPath(other,hidden,'ai-narrative'))).status).toBe(200);
  expect((await h.read(hidden)).status,'a draft narrative behind content blocks is not what was reviewed').toBe('reviewed');
 });

 it('holds no lock on the document while the model runs',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'auto_generated',sectionType:aiType,content:table});
  vi.mocked(generateNoteNarrative).mockImplementationOnce(async()=>{
   // A sign-off taking the document row now must not wait on the model call.
   await h.pool.query('SELECT id FROM afs_documents WHERE company_id=$1 AND id=$2 FOR UPDATE NOWAIT',[h.f.companyA,doc]);
   return 'Synthetic narrative';
  });
  const res=await h.request('POST',h.sectionPath(doc,id,'ai-narrative'));
  expect(res.status,`the document was locked for the model call: ${JSON.stringify(res.body)}`).toBe(200);
 });

 it('refuses to store a narrative when the section changed while the model ran',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'auto_generated',sectionType:aiType,content:table});
  vi.mocked(generateNoteNarrative).mockImplementationOnce(async()=>{
   await h.pool.query(`UPDATE afs_sections SET content='{"title":"Changed","blocks":[]}'::jsonb WHERE company_id=$1 AND id=$2`,[h.f.companyA,id]);
   return 'Narrative of old content';
  });
  const res=await h.request('POST',h.sectionPath(doc,id,'ai-narrative'));
  expect(res.status,JSON.stringify(res.body)).toBe(409);
  expect((await h.read(id)).ai_narrative).toBeNull();
 });

 it.each(['POST','PUT'])('answers a malformed id with 400 on %s, not a database error',async method=>{
  const res=await h.request(method,h.sectionPath('not-a-uuid',randomUUID(),'ai-narrative'));
  expect(res.status,JSON.stringify(res.body)).toBe(400);
 });
});

describe('regenerate',()=>{
 it('regenerates a reviewed section from the ledger and voids its review',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'reviewed',sectionType:'note_11'});
  const res=await h.request('POST',h.sectionPath(doc,id,'regenerate'),{fiscalYear:2024,framework:'ifrs_smes'});
  expect(res.status,JSON.stringify(res.body)).toBe(200);
  const row=await h.read(id);
  expect(row.data_snapshot,'the generator wrote nothing').not.toBeNull();
  expect(['auto_generated','pending']).toContain(row.status);
  expect({reviewed_by:row.reviewed_by,signed_off_by:row.signed_off_by}).toEqual({reviewed_by:null,signed_off_by:null});
  expect(await h.audits(id)).toHaveLength(1);
 });
});

describe('reorder',()=>{
 const reorder=(doc:string,ids:string[])=>h.request('PUT',`/api/accounting/afs/${doc}/sections/reorder`,{sections:ids.map((id,i)=>({id,newSortOrder:i+1}))});
 it('reorders the sections of an editable document',async()=>{
  const doc=await h.document(),a=await h.section(doc),b=await h.section(doc);
  expect((await reorder(doc,[b,a])).status).toBe(200);
  expect([(await h.read(b)).sort_order,(await h.read(a)).sort_order]).toEqual([1,2]);
 });
 it.each(['signed_off','filed'])('refuses to renumber the notes of a %s document',async status=>{
  const doc=await h.document(status),a=await h.section(doc,{status:'signed_off'}),b=await h.section(doc,{status:'signed_off'});
  const before=[(await h.read(a)).sort_order,(await h.read(b)).sort_order];
  const res=await reorder(doc,[b,a]);
  expect(res.status,JSON.stringify(res.body)).toBe(409);
  expect([(await h.read(a)).sort_order,(await h.read(b)).sort_order]).toEqual(before);
 });
 it('refuses a section of another document',async()=>{
  const doc=await h.document(),own=await h.section(doc),foreign=await h.section(await h.document());
  const res=await reorder(doc,[own,foreign]);
  expect(res.status,JSON.stringify(res.body)).toBe(404);
  expect((await h.read(own)).sort_order).toBe(0);
 });
});

describe('review comments',()=>{
 const comments=(doc:string,id:string)=>h.sectionPath(doc,id,'comments');
 it('adds, lists and resolves a comment on a section of this document',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'auto_generated'});
  const added=await h.request('POST',comments(doc,id),{body:'Check the total'});
  expect(added.status,JSON.stringify(added.body)).toBe(201);
  const commentId=String(added.body.data?.id);
  expect(((await h.request('GET',comments(doc,id))).body.data?.items as unknown[]).length).toBe(1);
  expect((await h.request('POST',`${comments(doc,id)}/${commentId}/resolve`)).status).toBe(200);
 });
 it('refuses a comment, a listing and a resolution addressed through another document',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'auto_generated'}),other=await h.document();
  const commentId=String((await h.request('POST',comments(doc,id),{body:'Own'})).body.data?.id);
  expect((await h.request('POST',comments(other,id),{body:'Foreign'})).status).toBe(404);
  expect((await h.request('GET',comments(other,id))).status).toBe(404);
  expect((await h.request('POST',`${comments(other,id)}/${commentId}/resolve`)).status).toBe(404);
  const foreignSection=await h.section(doc,{status:'auto_generated'});
  expect((await h.request('POST',`${comments(doc,foreignSection)}/${commentId}/resolve`)).status,'resolved through the wrong section').toBe(404);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM afs_section_comments WHERE company_id=$1 AND section_id=$2 AND resolved=false',[h.f.companyA,id])).rows[0].n).toBe(1);
 });
 it.each(['signed_off','filed'])('refuses to add or resolve a comment on a %s document',async status=>{
  const doc=await h.document(),id=await h.section(doc,{status:'auto_generated'});
  const commentId=String((await h.request('POST',comments(doc,id),{body:'Before lock'})).body.data?.id);
  await h.pool.query('UPDATE afs_documents SET status=$3 WHERE company_id=$1 AND id=$2',[h.f.companyA,doc,status]);
  expect((await h.request('POST',comments(doc,id),{body:'After lock'})).status).toBe(409);
  expect((await h.request('POST',`${comments(doc,id)}/${commentId}/resolve`)).status).toBe(409);
  expect((await h.pool.query('SELECT count(*)::int AS n FROM afs_section_comments WHERE company_id=$1 AND section_id=$2 AND resolved=false',[h.f.companyA,id])).rows[0].n).toBe(1);
 });
});

describe('an impersonated session',()=>{
 it('is refused with 403, not a server error, when its edit would void a review',async()=>{
  const doc=await h.document(),id=await h.section(doc,{status:'reviewed'}),before=await h.read(id);
  const res=await h.request('PUT',h.sectionPath(doc,id,'overrides'),{overrides:{title:'Impersonated',blocks:[]}},'u1',await h.impersonatedSession('u1'));
  expect(res.status,JSON.stringify(res.body)).toBe(403);
  expect(await h.read(id)).toEqual(before);
 });
});
