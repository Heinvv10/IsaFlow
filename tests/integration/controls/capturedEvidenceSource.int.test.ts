import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {loadBankStatementSource} from '@/modules/accounting/services/controls/bankStatementAttestationSource';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
const bytes=Buffer.from('Synthetic statement stored outside PostgreSQL'),hash=createHash('sha256').update(bytes).digest('hex');
let fixture:ForensicFixture,server:Server,mode='valid',requests=0;
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 server=createServer((_request,response)=>{requests++;response.writeHead(mode==='missing'?404:200);response.end(mode==='changed'?'altered':bytes);});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic storage listener unavailable');
 vi.stubEnv('SUPABASE_URL',`http://127.0.0.1:${address.port}`);vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','synthetic-local-key');
 vi.stubEnv('SUPABASE_CAPTURED_DOCS_BUCKET','captured-documents');
});
afterAll(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));vi.unstubAllEnvs();await pool.end();});
async function source(options:{foreignPath?:boolean;deny?:boolean}={}){
 const client=await pool.connect(),account=randomUUID(),document=randomUUID();
 try{
  await client.query('BEGIN');
  // Reproduce committed migration411 schema, without changing other fixture users' persisted schema.
  await client.query('ALTER TABLE public.captured_documents DROP COLUMN IF EXISTS raw_bytes');
  await client.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,level,is_active) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bank','asset','bank','debit',3,true)",[account,fixture.companyA]);
  await client.query("INSERT INTO captured_documents(id,company_id,status,file_name,file_type,raw_bytes_sha256,raw_bytes_size,storage_bucket,storage_path) VALUES($1,$2,'matched','synthetic.pdf','pdf',$3,$4,'captured-documents',$5)",
   [document,fixture.companyA,hash,bytes.length,`${options.foreignPath?fixture.companyB:fixture.companyA}/${document}`]);
  if(options.deny)await client.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'banking',false,false) ON CONFLICT(company_id,user_id,module_key) DO UPDATE SET can_read=false,can_write=false",[fixture.companyA,fixture.u1.id]);
  await client.query('SET LOCAL ROLE app_user');
  const claims={sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  return await withControlRequest({client,userId:fixture.u1.id,companyId:fixture.companyA,claims},
   {personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'cookie'},()=>loadBankStatementSource(requireControlTx(),account,document,hash));
 }finally{await client.query('ROLLBACK');client.release();}
}
it('uses real object storage under the migration411 schema without a raw_bytes column',async()=>{
 const result=await source();expect(result.document.hash).toBe(hash);expect(result.currency).toBe('ZAR');expect(requests).toBeGreaterThan(0);
});
it('refuses altered actual object bytes even when recorded metadata still matches approval',async()=>{
 mode='changed';try{await expect(source()).rejects.toThrow(/changed|unavailable/i);}finally{mode='valid';}
});
it('refuses a foreign storage namespace before sending credentials or fetching bytes',async()=>{
 const before=requests;await expect(source({foreignPath:true})).rejects.toThrow(/namespace/i);expect(requests).toBe(before);
});
it('rechecks current bank permission before resolving an owned stored document',async()=>{
 const before=requests;await expect(source({deny:true})).rejects.toThrow(/permission|scope|denied/i);expect(requests).toBe(before);
});
it('does not attest a missing real storage object',async()=>{
 mode='missing';try{await expect(source()).rejects.toThrow(/unavailable/i);}finally{mode='valid';}
});
