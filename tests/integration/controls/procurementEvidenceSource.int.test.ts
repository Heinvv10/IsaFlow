import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {loadOwnedProcurementEvidence} from '@/modules/accounting/services/controls/procurementEvidenceSource';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
const bytes=Buffer.from('Synthetic statement stored outside PostgreSQL'),hash=createHash('sha256').update(bytes).digest('hex');
let fixture:ForensicFixture,server:Server,mode='valid',requests=0;
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 server=createServer((_request,response)=>{requests++;response.writeHead(mode==='missing'?404:200);response.end(mode==='changed'?'altered':bytes);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic storage listener unavailable');
 vi.stubEnv('VF_STORAGE_URL',`http://127.0.0.1:${address.port}`);

});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));vi.unstubAllEnvs();await pool.end();});
async function source(options:{foreignParent?:boolean;deny?:boolean;wrongType?:boolean;inactive?:boolean;foreignPath?:boolean}={}){
 const client=await pool.connect(),parent=randomUUID(),document=randomUUID();
 try{
  await client.query('BEGIN');
  await client.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(company_id,user_id) DO NOTHING",[fixture.companyB,fixture.u1.id]);
  await client.query("INSERT INTO credit_notes(id,company_id,type,credit_date,created_by) VALUES($1,$2,'customer','2026-09-09',$3)",[parent,options.foreignParent?fixture.companyB:fixture.companyA,fixture.u1.id]);
  const entityType=options.wrongType?'supplier_invoice':'credit_note';
  await client.query("INSERT INTO procurement_documents(id,entity_type,entity_id,file_path,file_size,mime_type,is_active) VALUES($1,$2,$3,$4,$5,'application/pdf',$6)",
   [document,entityType,parent,`accounting/${entityType}/${options.foreignPath?document:parent}_synthetic.pdf`,bytes.length,!options.inactive]);
  // A link to an owned target cannot transfer ownership from the original parent.
  const owned=randomUUID();
  await client.query("INSERT INTO credit_notes(id,company_id,type,credit_date,created_by) VALUES($1,$2,'customer','2026-09-09',$3)",[owned,fixture.companyA,fixture.u1.id]);
  await client.query("INSERT INTO document_links(document_id,linked_entity_type,linked_entity_id) VALUES($1,'credit_note',$2)",[document,owned]);
  if(options.deny)await client.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'customers',false,false) ON CONFLICT(company_id,user_id,module_key) DO UPDATE SET can_read=false,can_write=false",[fixture.companyA,fixture.u1.id]);
  await client.query('SET LOCAL ROLE app_user');
  const claims={sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  return await withControlRequest({client,userId:fixture.u1.id,companyId:fixture.companyA,claims},
   {personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'cookie'},()=>loadOwnedProcurementEvidence(requireControlTx(),document));
 }finally{await client.query('ROLLBACK');client.release();}
}
it('fetches actual owned original bytes with explicit unknown historical authenticity',async()=>{
 const result=await source();expect(result?.sha256).toBe(hash);expect(result?.recordedHashVerified).toBe(false);expect(Buffer.from(result!.bytes)).toEqual(bytes);
});
it('refuses foreign original parents despite dual membership and owned document links',async()=>{
 const before=requests;expect(await source({foreignParent:true})).toBeNull();expect(requests).toBe(before);
});
it('does not treat an owned credit-note UUID as an owned Sage supplier invoice',async()=>{
 const before=requests;expect(await source({wrongType:true})).toBeNull();expect(requests).toBe(before);
});
it('rechecks current invoice permission before HTTP',async()=>{
 const before=requests;await expect(source({deny:true})).rejects.toThrow(/permission|scope|denied/i);expect(requests).toBe(before);
});
it('omits inactive originals and refuses a foreign filename namespace',async()=>{
 const before=requests;expect(await source({inactive:true})).toBeNull();await expect(source({foreignPath:true})).rejects.toThrow(/namespace/i);expect(requests).toBe(before);
});
it('does not substitute metadata when the real source object is missing',async()=>{
 mode='missing';try{expect(await source()).toBeNull();}finally{mode='valid';}
});
