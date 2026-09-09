import {randomBytes,randomUUID} from 'node:crypto';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import type {RequestContext} from '@/lib/als';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,type ForensicFixture,validateFixtureTarget} from '../forensic-fixture';
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:1});
afterAll(()=>pool.end());
it.each(['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks'])('stores immutable tenant-protected bounded material in %s',async table=>{
 expect((await pool.query('SELECT to_regclass($1)::text AS name',[table])).rows[0].name).toBe(table);
 const row=(await pool.query("SELECT has_table_privilege('app_user',$1,'SELECT') AS read,has_table_privilege('app_user',$1,'INSERT') AS create,has_table_privilege('app_user',$1,'UPDATE') AS update,has_table_privilege('app_user',$1,'DELETE') AS delete",[table])).rows[0];
 expect(row).toEqual({read:true,create:true,update:false,delete:false});
 const rls=(await pool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass($1)',[table])).rows[0];
 expect(rls).toEqual({relrowsecurity:true,relforcerowsecurity:true});
});

let fixture:ForensicFixture,ownSnapshot:string,foreignSnapshot:string;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
function actor<T>(person:'u1'|'u2'|'u3',work:(store:RequestContext)=>Promise<T>){
 const user=fixture[person];
 return withAuditWorkerTransaction(pool,{companyId:user.companyId,personId:user.id,jobId:randomUUID()},'read committed',Date.now()+10000,undefined,
  store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},()=>work(store)));
}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(fixtureConfigFromEnv(process.env));
 const ids:string[]=[];
 for(const person of ['u1','u3'] as const){
  const job=await actor(person,()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
  const user=fixture[person];
  expect(await runAuditSnapshotJob({companyId:user.companyId,personId:user.id,jobId:job.id},{pool})).toMatchObject({state:'succeeded'});ids.push(job.id);
 }
 [ownSnapshot,foreignSnapshot]=ids as [string,string];
});
it('permits owned append-only index rows but rejects foreign and different-maker creation',async()=>{
 // Storage-policy fixtures intentionally use opaque dummy envelopes; material authentication has separate tests.
 await actor('u1',async({client})=>{
  // The real worker now inserts the header under the same maker's RLS authority.
  expect((await client.query('SELECT snapshot_id FROM control_audit_snapshot_indexes WHERE company_id=$1 AND snapshot_id=$2',[fixture.companyA,ownSnapshot])).rows).toHaveLength(1);
  await client.query("INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item) VALUES($1,$2,'records',0,'{}')",[fixture.companyA,ownSnapshot]);
  await client.query("INSERT INTO control_audit_snapshot_index_chunks(company_id,snapshot_id,section,ordinal,chunk_ordinal,protected_chunk) VALUES($1,$2,'records',0,0,'{}')",[fixture.companyA,ownSnapshot]);
 });
 await expect(actor('u1',({client})=>client.query("INSERT INTO control_audit_snapshot_indexes(company_id,snapshot_id,protected_header) VALUES($1,$2,'{}')",[fixture.companyB,foreignSnapshot]))).rejects.toMatchObject({code:'42501'});
 await expect(actor('u2',({client})=>client.query("INSERT INTO control_audit_snapshot_index_items(company_id,snapshot_id,section,ordinal,protected_item) VALUES($1,$2,'records',1,'{}')",[fixture.companyA,ownSnapshot]))).rejects.toMatchObject({code:'42501'});
 for(const table of ['control_audit_snapshot_indexes','control_audit_snapshot_index_items','control_audit_snapshot_index_chunks']){
  // Fixed test-owned table identifiers only; application readers use tagged SQL.
  expect((await actor('u3',({client})=>client.query(`SELECT company_id FROM ${table} WHERE company_id=$1`,[fixture.companyA]))).rows).toEqual([]);
  await expect(actor('u1',({client})=>client.query(`DELETE FROM ${table} WHERE company_id=$1`,[fixture.companyA]))).rejects.toMatchObject({code:'42501'});
 }
});
it('rejects oversized encrypted chunks at the storage boundary',async()=>{
 await expect(actor('u1',({client})=>client.query("INSERT INTO control_audit_snapshot_index_chunks(company_id,snapshot_id,section,ordinal,chunk_ordinal,protected_chunk) VALUES($1,$2,'records',0,1,$3::jsonb)",[fixture.companyA,ownSnapshot,JSON.stringify({ciphertext:'x'.repeat(1048576)})]))).rejects.toMatchObject({code:'23514'});
});
