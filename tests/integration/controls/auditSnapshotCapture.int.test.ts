import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {captureAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotCapture';
import {sealAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotSeal';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
let fixture:ForensicFixture,debit:string,credit:string;
process.env.CONTROL_SNAPSHOT_SIGNING_KEY='synthetic-snapshot-key-kept-outside-database';
const request={cutoff:'2026-09-09',sources:['journals'] as const,checks:[],idempotencyKey:'capture'};
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,isolation='REPEATABLE READ',person:'u1'|'u3'='u1'){
 const client=await pool.connect(),user=fixture[person];try{
  await client.query(isolation==='REPEATABLE READ'?'BEGIN ISOLATION LEVEL REPEATABLE READ':'BEGIN');
  await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const value=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
   {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  await client.query('COMMIT');return value;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
function capture(ctx:ControlTx){return captureAuditSnapshot(ctx,{snapshotId:randomUUID(),request:{...request,sources:[...request.sources]}});}
beforeEach(async()=>{
 fixture=await provisionForensicFixture(config);debit=randomUUID();credit=randomUUID();
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,level)
 VALUES($1::uuid,$3,left($1::text,12),'Synthetic debit','asset','debit',3),($2::uuid,$3,left($2::text,12),'Synthetic credit','liability','credit',3)`,[debit,credit,fixture.companyA]);
});
afterAll(()=>pool.end());
async function journal(date='2026-09-09'){
 const id=randomUUID();await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by)
 VALUES($1,$2,$3,$1::text,'manual','draft',$4)`,[id,fixture.companyA,date,fixture.u1.id]);
 await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
 VALUES($1,$2,$3,100,0),($1,$2,$4,0,100)`,[id,fixture.companyA,debit,credit]);return id;
}
it('refuses READ COMMITTED instead of publishing a potentially mixed capture',async()=>{
 await expect(actor(capture,'READ COMMITTED')).rejects.toThrow(/repeatable read/i);
});
it('materializes the complete owned journal population through multiple keyset pages',async()=>{
 const ids=Array.from({length:501},()=>randomUUID());
 await pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_date,entry_number,source,status,created_by)
 SELECT id,$2,'2026-09-09',id::text,'manual','draft',$3 FROM unnest($1::uuid[]) id`,[ids,fixture.companyA,fixture.u1.id]);
 await pool.query(`INSERT INTO gl_journal_lines(journal_entry_id,company_id,gl_account_id,debit,credit)
 SELECT id,$2,$3,100,0 FROM unnest($1::uuid[]) id UNION ALL SELECT id,$2,$4,0,100 FROM unnest($1::uuid[]) id`,[ids,fixture.companyA,debit,credit]);
 await journal('2026-09-10');
 const result=await actor(capture);
 expect(result.records.filter(r=>r.source==='journal_entry')).toHaveLength(501);
 const lines=result.records.filter(r=>r.source==='journal_line');expect(lines).toHaveLength(1002);
 expect(lines.reduce((sum,r)=>sum+Number(r.data.debit),0)).toBe(50100);
 expect(result.populations.find(p=>p.source==='journal_entry')).toMatchObject({count:501,excludedCount:1});
 expect(result.populations.find(p=>p.source==='journal_line')).toMatchObject({count:1002,excludedCount:2});
 expect((await actor(capture,'REPEATABLE READ','u3')).records).toEqual([]);
 expect(()=>sealAuditSnapshot(result)).not.toThrow();
});
it('retains an old capture after a later backdated addition',async()=>{
 await journal();const first=await actor(capture),sealed=sealAuditSnapshot(first);
 await journal('2026-08-31');const second=await actor(capture);
 expect(first.records).toHaveLength(3);expect(second.records).toHaveLength(6);
 expect(sealAuditSnapshot(first)).toEqual(sealed);
});
