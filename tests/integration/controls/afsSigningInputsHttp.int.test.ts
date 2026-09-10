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
  ['the period on the cover',({doc})=>["UPDATE afs_documents SET period='2099-02' WHERE company_id=$1 AND id=$2",[h.f.companyA,doc]],/document settings/i],
  ['the fiscal year',({doc})=>["UPDATE afs_documents SET fiscal_year=2099 WHERE company_id=$1 AND id=$2",[h.f.companyA,doc]],/document settings/i],
  ['the reporting framework',({doc})=>["UPDATE afs_documents SET reporting_framework='full_ifrs' WHERE company_id=$1 AND id=$2",[h.f.companyA,doc]],/document settings/i],
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
 /** Runs `statement` on its own connection from inside the render; returns once it is blocked or done. */
 function landMidRender(statement:string,params:unknown[]){
  const landed:{done?:Promise<unknown>}={};
  vi.mocked(renderDocumentHtml).mockImplementationOnce(async(...args)=>{
   const html=await realRenderDocumentHtml(...args);
   const client=await h.pool.connect();
   const pid=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
   let finished=false;
   landed.done=client.query(statement,params).finally(()=>{finished=true;client.release();});
   for(let attempt=0;attempt<300&&!finished;attempt++){
    const blocked=(await h.pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS b',[pid])).rows[0].b as boolean;
    if(blocked)break;
    await new Promise(done=>setTimeout(done,10));
   }
   return html;
  });
  return landed;
 }

 it('cannot sign branding changed under the send: the edit waits, and the signature is then refused',async()=>{
  const {doc,contact}=await s.readyToSign();
  try{
   const landed=landMidRender("UPDATE brand_profiles SET primary_colour='#abcdef' WHERE company_id=$1",[h.f.companyA]);
   const signum=await s.send(doc,contact);
   await landed.done;
   const row=await s.signed(signum,doc);
   expect(row.status,'Signum got the old branding while the fingerprint recorded the new').toBe('partner_review');
   expect(String(row.signing_refused_reason)).toMatch(/branding/i);
  }finally{await h.pool.query("UPDATE brand_profiles SET primary_colour='#123456' WHERE company_id=$1",[h.f.companyA]);}
 });

 it('refuses the send when a first brand profile is saved while it renders',async()=>{
  const {doc,contact}=await s.readyToSign();
  await h.pool.query('DELETE FROM brand_profiles WHERE company_id=$1',[h.f.companyA]);
  try{
   const landed=landMidRender(`INSERT INTO brand_profiles(company_id,primary_colour,secondary_colour,font_family,cover_style)
    VALUES($1,'#123456','#654321','professional','classic')`,[h.f.companyA]);
   s.posted.length=0;
   const res=await s.sendRequest(doc,contact);
   await landed.done;
   expect(res.status,`a render on the default branding was signed as the new profile: ${JSON.stringify(res.body)}`).toBe(409);
   expect(s.posted,'the document went to the signatories anyway').toHaveLength(0);
   expect((await h.readDocument(doc)).signing_requested_at).toBeNull();
  }finally{await h.brandProfile();}
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
   const brand=await h.request('PUT','/api/accounting/afs/brand-profile',{...same,primaryColour:'#1e3a5f'});
   expect(JSON.stringify(brand.body.data?.warnings),'the branding change gave no warning').toContain(doc);

   const resave=await h.request('PUT','/api/accounting/companies',{id:h.f.companyA,name:before.name,registrationNumber:before.registration_number});
   expect(resave.status,JSON.stringify(resave.body)).toBe(200);
   expect(resave.body.data?.warnings,'re-saving the same company details warned anyway').toEqual([]);
   const renamed=await h.request('PUT','/api/accounting/companies',{id:h.f.companyA,registrationNumber:'2024/000001/07'});
   expect(renamed.status,JSON.stringify(renamed.body)).toBe(200);
   expect(JSON.stringify(renamed.body.data?.warnings),'the company change gave no warning').toContain(doc);
  }finally{await restore(before);}
 });
});
