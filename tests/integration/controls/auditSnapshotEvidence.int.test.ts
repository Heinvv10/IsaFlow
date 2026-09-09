import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {captureAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotCapture';
import {retainSnapshotEvidence} from '@/modules/accounting/services/controls/auditSnapshotEvidence';
import {sealAuditSnapshot,verifyAuditSnapshot,verifySnapshotArtifact} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import {capturedEvidenceHttpFixture} from './capturedEvidenceHttpFixture';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:2});
const bytes=Buffer.from('Synthetic retained document bytes');
let fixture:ForensicFixture,storage:Awaited<ReturnType<typeof capturedEvidenceHttpFixture>>,server:Server;
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);storage=await capturedEvidenceHttpFixture();
 server=createServer((_req,res)=>res.end(bytes));await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('Synthetic listener unavailable');
 vi.stubEnv('VF_STORAGE_URL',`http://127.0.0.1:${address.port}`);vi.stubEnv('CONTROL_SNAPSHOT_SIGNING_KEY','synthetic-retention-signing-key-outside-database');
});
afterAll(async()=>{await storage.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));vi.unstubAllEnvs();await pool.end();});
async function retain(missing=false){
 const client=await pool.connect(),bank=randomUUID(),account=randomUUID(),captured=randomUUID(),attachment=randomUUID(),sage=randomUUID(),procurement=randomUUID();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  await client.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level) VALUES($1,$2,left($1::uuid::text,20),'Synthetic bank','asset','debit',3)",[account,fixture.companyA]);
  await client.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount) VALUES($1,$2,$3,'2026-09-09',100)",[bank,fixture.companyA,account]);
  await client.query("INSERT INTO captured_documents(id,company_id,status,file_name,file_type,matched_bank_tx_id) VALUES($1,$2,'matched','synthetic.pdf','pdf',$3)",[captured,fixture.companyA,bank]);
  await storage.seed(client,fixture.companyA,captured,bytes);if(missing)storage.remove(fixture.companyA,captured);
  await client.query('INSERT INTO bank_transaction_attachments(id,bank_transaction_id,file_url,file_size) VALUES($1,$2,$3,$4)',[attachment,bank,`data:application/pdf;base64,${bytes.toString('base64')}`,bytes.length]);
  await client.query("INSERT INTO sage_supplier_invoices(id,company_id,invoice_date,total_amount) VALUES($1,$2,'2026-09-09',100)",[sage,fixture.companyA]);
  await client.query("INSERT INTO procurement_documents(id,entity_type,entity_id,file_path,file_size,mime_type,is_active) VALUES($1,'supplier_invoice',$2,$3,$4,'application/pdf',true)",[procurement,sage,`accounting/supplier_invoice/${sage}_synthetic.pdf`,bytes.length]);
  await client.query('SET LOCAL ROLE app_user');const claims={sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  return await withControlRequest({client,userId:fixture.u1.id,companyId:fixture.companyA,claims},{personId:fixture.u1.id,companyId:fixture.companyA,authMethod:'cookie'},async()=>{
   const request={cutoff:'2026-09-09',sources:['ap','bank'] as ('ap'|'bank')[],checks:[],idempotencyKey:'synthetic-retain'};
   const snapshot=await captureAuditSnapshot(requireControlTx(),{snapshotId:randomUUID(),request});
   const result=await retainSnapshotEvidence(requireControlTx(),snapshot,request);
   const sealed=sealAuditSnapshot(result.snapshot),verified=verifyAuditSnapshot(sealed,{companyId:fixture.companyA,snapshotId:snapshot.snapshotId});
   storage.put(fixture.companyA,captured,Buffer.from('Changed source after retention'));
   for(const artifact of result.artifacts)verifySnapshotArtifact(verified,artifact.id,artifact.bytes);
   return{...result,captured,attachment,procurement};
  });
 }finally{await client.query('ROLLBACK');client.release();}
}
it('captures and retains all three actual owned document stores before sealing',async()=>{
 const result=await retain();expect(result.artifacts.map(row=>row.id).sort()).toEqual([`captured:${result.captured}`,`bank_attachment:${result.attachment}`,`procurement:${result.procurement}`].sort());
 for(const artifact of result.artifacts)expect(Buffer.from(artifact.bytes)).toEqual(bytes);
 expect(result.snapshot.evidence.every(row=>row.relations?.length)).toBe(true);
 expect(result.snapshot.missingSources).toContain('procurement:historical_source_hash_unavailable');
 expect(result.snapshot.missingSources).toContain('bank_attachment:historical_source_hash_unavailable');
});
it('authenticates absent actual storage bytes as a precise gap while retaining available evidence',async()=>{
 const result=await retain(true);expect(result.artifacts).toHaveLength(2);
 expect(result.snapshot.evidenceGaps).toMatchObject([{id:`captured:${result.captured}`,reason:'source_bytes_unavailable',relations:[{parentSource:'bank_transaction',relation:'matched_bank'}]}]);
});
