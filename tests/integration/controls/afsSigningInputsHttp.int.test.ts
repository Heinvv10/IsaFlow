import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {afsSectionHttpFixture} from './afsSectionHttpFixture';
import {signingHarness} from './afsSigningHarness';
import {renderDocumentHtml,realRenderDocumentHtml} from '@/modules/accounting/services/afs/pdfExportService';

// Outbound mail and the Signum HTTP API are the boundaries replaced (the harness answers the
// latter at the network edge). The renderer is the real one, wrapped so a test can land a
// concurrent write in the middle of a send.
vi.mock('@/modules/accounting/services/afs/portalNotificationService',()=>({notifySigningRequested:vi.fn(async()=>undefined),notifyDocumentSignedOff:vi.fn(async()=>undefined)}));
vi.mock('@/modules/accounting/services/afs/pdfExportService',async importOriginal=>{
 const real=await importOriginal<typeof import('@/modules/accounting/services/afs/pdfExportService')>();
 return{...real,realRenderDocumentHtml:real.renderDocumentHtml,renderDocumentHtml:vi.fn(real.renderDocumentHtml)};
});

/**
 * The signature covers every input the statements are rendered from, the refusal names the one
 * that moved, an edit racing the send cannot be signed, and the settings pages warn which
 * signature an edit will void.
 */
let h:Awaited<ReturnType<typeof afsSectionHttpFixture>>;
let s:ReturnType<typeof signingHarness>;
beforeAll(async()=>{h=await afsSectionHttpFixture();s=signingHarness(h);},30000);
afterAll(async()=>{vi.restoreAllMocks();await h?.close();});

async function company(){return (await h.pool.query('SELECT name,registration_number FROM companies WHERE id=$1',[h.f.companyA])).rows[0] as {name:string;registration_number:string|null};}
async function restore(before:{name:string;registration_number:string|null}){
 await h.pool.query('UPDATE companies SET name=$2,registration_number=$3 WHERE id=$1',[h.f.companyA,before.name,before.registration_number]);
 await h.pool.query('DELETE FROM brand_profiles WHERE company_id=$1',[h.f.companyA]);
 await h.brandProfile();
}

describe('the fingerprint covers every input the statements are rendered from',()=>{
 type Change=(ids:{doc:string;section:string})=>[string,unknown[]];
 const cases:[string,Change,RegExp][]=[
  ['the registered company name',()=>["UPDATE companies SET name='Renamed After Signing' WHERE id=$1",[h.f.companyA]],/registered company/i],
  ['the registration number',()=>["UPDATE companies SET registration_number='2099/123456/07' WHERE id=$1",[h.f.companyA]],/registered company/i],
  ['the period on the cover',({doc})=>["UPDATE afs_documents SET period='2099-02' WHERE company_id=$1 AND id=$2",[h.f.companyA,doc]],/reporting period/i],
  ['the fiscal year',({doc})=>["UPDATE afs_documents SET fiscal_year=2099 WHERE company_id=$1 AND id=$2",[h.f.companyA,doc]],/reporting period/i],
  ['the primary colour',()=>["UPDATE brand_profiles SET primary_colour='#abcdef' WHERE company_id=$1",[h.f.companyA]],/branding/i],
  ['the secondary colour',()=>["UPDATE brand_profiles SET secondary_colour='#111111' WHERE company_id=$1",[h.f.companyA]],/branding/i],
  ['the logo',()=>["UPDATE brand_profiles SET logo_url='https://cdn.example.com/new-logo.png' WHERE company_id=$1",[h.f.companyA]],/branding/i],
  ['the cover style',()=>["UPDATE brand_profiles SET cover_style='modern' WHERE company_id=$1",[h.f.companyA]],/branding/i],
  ['the font',()=>["UPDATE brand_profiles SET font_family='modern' WHERE company_id=$1",[h.f.companyA]],/branding/i],
  ['a section\'s overrides',({section})=>[`UPDATE afs_sections SET overrides='{"title":"Override","blocks":[]}'::jsonb WHERE company_id=$1 AND id=$2`,[h.f.companyA,section]],/section/i],
  ['a section\'s data snapshot',({section})=>[`UPDATE afs_sections SET data_snapshot='{"total":1}'::jsonb WHERE company_id=$1 AND id=$2`,[h.f.companyA,section]],/section/i],
  ['a section\'s note number',({section})=>['UPDATE afs_sections SET sort_order=99 WHERE company_id=$1 AND id=$2',[h.f.companyA,section]],/section/i],
  ['a section\'s type, which picks its chart',({section})=>["UPDATE afs_sections SET section_type='balance_sheet' WHERE company_id=$1 AND id=$2",[h.f.companyA,section]],/section/i],
 ];
 it.each(cases)('refuses the signature when %s changed after the send, and names that input',async(_what,change,named)=>{
  const before=await company();
  const {doc,sections:[a],contact}=await s.readyToSign();
  const signum=await s.send(doc,contact);
  try{
   const [statement,params]=change({doc,section:a});
   await h.pool.query(statement,params);
   const row=await s.signed(signum,doc);
   expect(row.status,'the document was signed off over a render nobody saw').toBe('partner_review');
   expect(String(row.signing_refused_reason),'the refusal sends the operator to the wrong input').toMatch(named);
  }finally{await restore(before);}
 });

 it.each([
  ['the report footer, which the statements never print',()=>["UPDATE brand_profiles SET report_footer_text='Footer changed after the send' WHERE company_id=$1",[h.f.companyA]]],
  ['a draft AI narrative behind the content blocks',({section})=>["UPDATE afs_sections SET ai_narrative='A narrative nobody prints' WHERE company_id=$1 AND id=$2",[h.f.companyA,section]]],
  ['the reporting framework, which the statements do not print',({doc})=>["UPDATE afs_documents SET reporting_framework='full_ifrs' WHERE company_id=$1 AND id=$2",[h.f.companyA,doc]]],
 ] as [string,Change][])('does not void the signature when %s changes: the signed bytes are the same',async(_what,change)=>{
  const before=await company();
  const {doc,sections:[a],contact}=await s.readyToSign();
  const signum=await s.send(doc,contact);
  try{
   const [statement,params]=change({doc,section:a});
   await h.pool.query(statement,params);
   const row=await s.signed(signum,doc);
   expect(row.status,`a change to nothing the statements show refused the signature: ${String(row.signing_refused_reason)}`).toBe('signed_off');
  }finally{await restore(before);}
 });

 it('renders sections with the same note number in one order, by id',async()=>{
  // Nothing makes sort_order unique. With no tiebreak, two sections sharing a number come out in
  // whatever order the scan returns them — one fingerprint, two byte orders.
  await h.brandProfile();
  const doc=await h.document('partner_review');
  const low='00000000-0000-4000-8000-'+Date.now().toString(16).padStart(12,'0');
  const high='ffffffff-ffff-4fff-bfff-'+Date.now().toString(16).padStart(12,'0');
  // Every order the scan might use disagrees with id order: the HIGHER id is written first and
  // carries the alphabetically FIRST section type (the (document_id, section_type) index is what
  // the planner walks).
  await h.section(doc,{id:high,sortOrder:5,status:'signed_off',sectionType:`aaa_tied_${Date.now()}`,content:{title:'High',blocks:[{type:'paragraph',text:'Tied note HIGH'}]}});
  await h.section(doc,{id:low,sortOrder:5,status:'signed_off',sectionType:`zzz_tied_${Date.now()}`,content:{title:'Low',blocks:[{type:'paragraph',text:'Tied note LOW'}]}});
  for(let attempt=0;attempt<2;attempt++){
   const html=await realRenderDocumentHtml(doc,h.f.companyA,{skipChecks:true,allowDefaultBrandProfile:true});
   const [lowAt,highAt]=[html.indexOf('Tied note LOW'),html.indexOf('Tied note HIGH')];
   expect(Math.min(lowAt,highAt),'a tied note was not rendered at all').toBeGreaterThan(-1);
   expect(lowAt,'tied notes were printed in storage order, not by id').toBeLessThan(highAt);
   // A no-op update moves a row version; the order must not follow it.
   await h.pool.query('UPDATE afs_sections SET sort_order=sort_order WHERE company_id=$1 AND id=$2',[h.f.companyA,attempt===0?high:low]);
  }
 });

 it.each([
  // concat_ws drops a NULL outright, so a cleared field and its neighbour's text can trade places:
  ['a NULL registration',['Acme','1998/012345/07'],['Acme|1998/012345/07',null]],
  // and it has no escaping, so the separator can move between two non-empty fields:
  ['a shifted separator',['Acme|1998','012345/07'],['Acme','1998|012345/07']],
 ] as const)('cannot be fooled by moving text between two fields (%s)',async(_case,sent,changed)=>{
  const before=await company();
  await h.pool.query('UPDATE companies SET name=$2,registration_number=$3 WHERE id=$1',[h.f.companyA,...sent]);
  try{
   const {doc,contact}=await s.readyToSign();
   const signum=await s.send(doc,contact);
   await h.pool.query('UPDATE companies SET name=$2,registration_number=$3 WHERE id=$1',[h.f.companyA,...changed]);
   expect((await s.signed(signum,doc)).status,'two different registrations hashed the same').toBe('partner_review');
  }finally{await restore(before);}
 });

 it('refuses when a company that sent on the default branding saves a profile before the signature arrives',async()=>{
  const {doc,contact}=await s.readyToSign();
  await h.pool.query('DELETE FROM brand_profiles WHERE company_id=$1',[h.f.companyA]);
  try{
   const signum=await s.send(doc,contact);
   await h.brandProfile();
   const row=await s.signed(signum,doc);
   expect(row.status,'the statements were signed on branding they no longer carry').toBe('partner_review');
   expect(String(row.signing_refused_reason)).toMatch(/branding/i);
  }finally{await h.brandProfile();}
 });

 it('refuses when a section becomes mandatory after the send and is not signed off',async()=>{
  // The fingerprint covers the sections but not the template registry, so this is the case the
  // "no longer signed off" count exists for.
  const {doc,sections:[,b],contact}=await s.readyToSign();
  const type=(await h.pool.query('SELECT section_type FROM afs_sections WHERE company_id=$1 AND id=$2',[h.f.companyA,b])).rows[0].section_type as string;
  await h.pool.query("INSERT INTO note_templates(section_type,framework,title,is_mandatory) VALUES($1,'both','Synthetic optional note',false)",[type]);
  try{
   await h.pool.query("UPDATE afs_sections SET status='reviewed',signed_off_by=NULL,signed_off_at=NULL WHERE company_id=$1 AND id=$2",[h.f.companyA,b]);
   const signum=await s.send(doc,contact);
   await h.pool.query('UPDATE note_templates SET is_mandatory=true WHERE section_type=$1',[type]);
   const row=await s.signed(signum,doc);
   expect(row.status,'a mandatory section that was never signed off was signed over').toBe('partner_review');
   expect(String(row.signing_refused_reason)).toMatch(/not signed off/i);
  }finally{await h.pool.query('DELETE FROM note_templates WHERE section_type=$1',[type]);}
 });
});

describe('an edit that lands while the send is rendering',()=>{
 /**
  * Commits `statement` on its own connection from inside the send, just before the renderer
  * runs — after the send has read and fingerprinted its inputs. Records whether the edit had to
  * wait for the send: nothing that edits the company or its branding should.
  */
 function landMidRender(statement:string,params:unknown[]){
  const landed={waited:false};
  vi.mocked(renderDocumentHtml).mockImplementationOnce(async(...args)=>{
   const client=await h.pool.connect();
   try{
    const done=client.query(statement,params);
    const outcome=await Promise.race([done.then(()=>'done'),new Promise(resolve=>setTimeout(()=>resolve('waiting'),3000))]);
    // If the send holds a lock the edit needs, let it finish after the send commits instead of
    // deadlocking the test — and record that it had to wait.
    if(outcome==='waiting'){landed.waited=true;void done.finally(()=>client.release());}
    else client.release();
   }catch(error){client.release();throw error;}
   return realRenderDocumentHtml(...args);
  });
  return landed;
 }

 it('signs exactly what it fingerprinted when the branding is edited under it, and refuses the signature after',async()=>{
  const {doc,contact}=await s.readyToSign();
  try{
   const landed=landMidRender("UPDATE brand_profiles SET primary_colour='#abcdef' WHERE company_id=$1",[h.f.companyA]);
   s.posted.length=0;
   const signum=await s.send(doc,contact);
   expect(landed.waited,'a branding save had to wait for a signing request').toBe(false);
   const html=s.posted.at(-1)!;
   expect(html,'the statements were rendered from values other than the ones fingerprinted').toContain('#123456');
   expect(html).not.toContain('#abcdef');
   const row=await s.signed(signum,doc);
   expect(row.status,'a signature over the old branding was accepted after it changed').toBe('partner_review');
   expect(String(row.signing_refused_reason)).toMatch(/branding/i);
  }finally{await h.pool.query("UPDATE brand_profiles SET primary_colour='#123456' WHERE company_id=$1",[h.f.companyA]);}
 });

 it('signs on the default branding it saw when a first brand profile is saved under it, and refuses the signature after',async()=>{
  const {doc,contact}=await s.readyToSign();
  await h.pool.query('DELETE FROM brand_profiles WHERE company_id=$1',[h.f.companyA]);
  try{
   const landed=landMidRender(`INSERT INTO brand_profiles(company_id,primary_colour,secondary_colour,font_family,cover_style)
    VALUES($1,'#123456','#654321','professional','classic')`,[h.f.companyA]);
   s.posted.length=0;
   const signum=await s.send(doc,contact);
   expect(landed.waited).toBe(false);
   expect(s.posted.at(-1)!,'the render picked up a profile the fingerprint never saw').not.toContain('#123456');
   expect(s.posted.at(-1)!,'the render used no branding at all rather than the documented default').toContain('#1e293b');
   const row=await s.signed(signum,doc);
   expect(row.status).toBe('partner_review');
   expect(String(row.signing_refused_reason)).toMatch(/branding/i);
  }finally{await h.brandProfile();}
 });

 it('signs the registered name it fingerprinted when the company is renamed under it, and refuses the signature after',async()=>{
  const before=await company();
  await h.pool.query("UPDATE companies SET name='Name At Send' WHERE id=$1",[h.f.companyA]);
  try{
   const {doc,contact}=await s.readyToSign();
   const landed=landMidRender("UPDATE companies SET name='Renamed Mid Send' WHERE id=$1",[h.f.companyA]);
   s.posted.length=0;
   const signum=await s.send(doc,contact);
   expect(landed.waited,'a company rename had to wait for a signing request').toBe(false);
   const html=s.posted.at(-1)!;
   expect(html,'the cover carries a name the fingerprint never saw').toContain('Name At Send');
   expect(html).not.toContain('Renamed Mid Send');
   const row=await s.signed(signum,doc);
   expect(row.status).toBe('partner_review');
   expect(String(row.signing_refused_reason)).toMatch(/registered company/i);
  }finally{await restore(before);}
 });

 it('lets an unrelated company setting be saved during a send, promptly, without voiding the signature',async()=>{
  const {doc,contact}=await s.readyToSign();
  const landed=landMidRender('UPDATE companies SET chase_grace_days=7 WHERE id=$1',[h.f.companyA]);
  const signum=await s.send(doc,contact);
  expect(landed.waited,'a chase-settings save waited on a signing request').toBe(false);
  expect((await s.signed(signum,doc)).status,'an unrelated setting voided the signature').toBe('signed_off');
 });
});

describe('editing the inputs of a document out for signature',()=>{
 it('is allowed, warns only when a signed input actually changes, and names the signature it will void',async()=>{
  const before=await company();
  const {doc,contact}=await s.readyToSign();
  await s.send(doc,contact);
  try{
   const same={primaryColour:'#123456',secondaryColour:'#654321',fontFamily:'professional',coverStyle:'classic'};
   const unchanged=await h.request('PUT','/api/accounting/afs/brand-profile',same);
   expect(unchanged.status,JSON.stringify(unchanged.body)).toBe(200);
   expect(unchanged.body.data?.warnings,'a save that changed nothing warned anyway').toEqual([]);
   // The footer is saved but never printed, so a footer-only save voids nothing and must not
   // tell the operator it will — they would cancel a valid signing at Signum for nothing.
   const footer=await h.request('PUT','/api/accounting/afs/brand-profile',{...same,reportFooterText:'A footer the statements never print'});
   expect(footer.status,JSON.stringify(footer.body)).toBe(200);
   expect(footer.body.data?.warnings,'a footer-only save claimed it would void a signature').toEqual([]);
   const brand=await h.request('PUT','/api/accounting/afs/brand-profile',{...same,reportFooterText:'A footer the statements never print',primaryColour:'#1e3a5f'});
   expect(JSON.stringify(brand.body.data?.warnings),'the branding change gave no warning').toContain(doc);

   const resave=await h.request('PUT','/api/accounting/companies',{id:h.f.companyA,name:before.name,registrationNumber:before.registration_number});
   expect(resave.status,JSON.stringify(resave.body)).toBe(200);
   expect(resave.body.data?.warnings,'re-saving the same company details warned anyway').toEqual([]);
   const unrelated=await h.request('PUT','/api/accounting/companies',{id:h.f.companyA,phone:'011 555 0100'});
   expect(unrelated.status,JSON.stringify(unrelated.body)).toBe(200);
   expect(unrelated.body.data?.warnings,'a change to nothing the statements print warned').toEqual([]);
   const renamed=await h.request('PUT','/api/accounting/companies',{id:h.f.companyA,registrationNumber:'2024/000001/07'});
   expect(renamed.status,JSON.stringify(renamed.body)).toBe(200);
   expect(JSON.stringify(renamed.body.data?.warnings),'the company change gave no warning').toContain(doc);
  }finally{await restore(before);}
 });
});
