import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {queryVerifiedBankStatements} from '@/modules/accounting/services/controls/bankStatementAttestationQuery';
import {prepareBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationPreparation';
import {materializeBankStatementAttestation} from '@/modules/accounting/services/controls/bankStatementAttestationMaterial';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});let fixture:ForensicFixture,account:string,document:string,hash:string;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u3'='u1'){
 const client=await pool.connect(),user=fixture[person];try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeEach(async()=>{
 fixture=await provisionForensicFixture(config);account=randomUUID();document=randomUUID();
 const bytes=Buffer.from('Synthetic independent local statement, zero transactions');hash=createHash('sha256').update(bytes).digest('hex');
 await pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[fixture.companyA]);
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,level)
 VALUES($1::uuid,$2,left($1::text,12),'Synthetic statement bank','asset','bank','debit',true,3)`,[account,fixture.companyA]);
 await pool.query(`INSERT INTO captured_documents(id,company_id,file_name,file_type,status,raw_bytes,raw_bytes_sha256)
 VALUES($1,$2,'synthetic-statement.pdf','pdf','matched',$3,$4)`,[document,fixture.companyA,bytes,hash]);
});
afterAll(()=>pool.end());
const input=()=>({bankAccountId:account,sourceDocumentId:document,expectedSourceHash:hash,periodStart:'2026-09-01',periodEnd:'2026-09-30',
 sourceCount:0,openingBalance:'-10',closingBalance:'-10',currency:'ZAR'});
it('prepares owned actual statement bytes and stable zero-count material without journal effects',async()=>{
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()));
 const material=await actor(ctx=>materializeBankStatementAttestation(ctx,prepared.operation));
 expect(material.binding.operation).toBe('bank_statement.attest');expect(material.binding.currency).toBe('ZAR');
 expect(material.binding.sourceVersions).toHaveLength(1);
 expect((await actor(ctx=>queryVerifiedBankStatements(ctx,null))).populationCount).toBe(0);
 expect((await pool.query('SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows[0].n).toBe(0);
});
it('rejects foreign owner, forged hash and changed actual bytes even when stored hash remains unchanged',async()=>{
 await expect(actor(ctx=>prepareBankStatementAttestation(ctx,input()),'u3')).rejects.toThrow();
 await expect(actor(ctx=>prepareBankStatementAttestation(ctx,{...input(),expectedSourceHash:'a'.repeat(64)}))).rejects.toThrow();
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()));
 await pool.query('UPDATE captured_documents SET raw_bytes=$1 WHERE company_id=$2 AND id=$3',[Buffer.from('Tampered'),fixture.companyA,document]);
 await expect(actor(ctx=>materializeBankStatementAttestation(ctx,prepared.operation))).rejects.toThrow();
});
it.each(['account','currency'] as const)('invalidates prepared statement after current %s changes',async kind=>{
 const prepared=await actor(ctx=>prepareBankStatementAttestation(ctx,input()));
 if(kind==='account')await pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,account]);
 else await pool.query("UPDATE companies SET default_currency='USD' WHERE id=$1",[fixture.companyA]);
 await expect(actor(ctx=>materializeBankStatementAttestation(ctx,prepared.operation))).rejects.toThrow();
});
