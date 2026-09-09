import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {storeHistoricalImportSource,readHistoricalImportSource} from '@/modules/accounting/services/controls/historicalImportSourceService';
import {prepareHistoricalImport} from '@/modules/accounting/services/controls/historicalImportPreparation';
import {materializeHistoricalImportOperation} from '@/modules/accounting/services/controls/historicalImportMaterializer';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config),pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:5000});
let fixture:ForensicFixture,sourceId:string,importId:string;
const account=randomUUID();
const source=()=>({version:1,sourceSystem:'csv',sourceKey:'H2-SYNTHETIC',kind:'gl',mode:'post_journal',accountingDate:'2023-02-28',currency:'ZAR',records:[
 {recordId:'1',accountCode:'H2-1000',debit:'100.01',credit:'0',description:'Synthetic debit'},
 {recordId:'2',accountCode:'H2-4000',debit:'0',credit:'100.01',description:'Synthetic credit'}]});
const prepare=(id=sourceId)=>({sourceSystem:'csv' as const,sourceKey:'H2-SYNTHETIC',kind:'gl' as const,mode:'post_journal' as const,accountingDate:'2023-02-28',evidenceId:id,sourceRecordIds:['1','2']});
async function actor<T>(person:'u1'|'u2'|'u3',fn:(ctx:ControlTx)=>Promise<T>){const client=await pool.connect(),user=fixture[person];try{
 await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
 await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
 const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
 if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Synthetic request did not commit');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
beforeAll(async()=>{fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance,is_active,level)
 VALUES($1,$2,'H2-1000','Synthetic H2 asset','asset','debit',true,3),($3,$2,'H2-4000','Synthetic H2 revenue','revenue','credit',true,3)`,[account,fixture.companyA,randomUUID()]);
 await pool.query("INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,'Synthetic H2 closed period',2,2023,'2023-02-01','2023-02-28','closed')",[fixture.companyA]);
});
afterAll(async()=>{await pool.end();});
it('persists actual encrypted evidence, prepares one exact immutable group and creates no financial effects',async()=>{
 const bytes=Buffer.from(JSON.stringify(source()));
 const stored=await actor('u1',ctx=>storeHistoricalImportSource(ctx,{bytes,mimeType:'application/json'}));sourceId=stored.sourceId;
 expect((await actor('u2',ctx=>readHistoricalImportSource(ctx,sourceId))).bytes.equals(bytes)).toBe(true);
 const prepared=await actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()));importId=prepared.importId;
 expect(prepared).toMatchObject({amount:'100.01',currency:'ZAR',requiresApproval:true});
 expect((await actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()))).importId).toBe(importId);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
 expect((await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
});
it('refuses foreign evidence, missing artifacts, changed dates and partial source record selections',async()=>{
 await expect(actor('u3',ctx=>readHistoricalImportSource(ctx,sourceId))).rejects.toThrow('unavailable');
 await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,prepare(randomUUID())))).rejects.toThrow('unavailable');
 await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,{...prepare(),accountingDate:'2023-03-01'}))).rejects.toThrow();
 await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,{...prepare(),sourceRecordIds:['1']}))).rejects.toThrow();
});
it('fingerprints current material changes and refuses missing currency and inactive owned accounts',async()=>{
 const read=()=>actor('u2',ctx=>materializeHistoricalImportOperation(ctx,{entityType:'historical_import',entityId:importId,operation:'historical_import.post'}));
 const before=canonicalJson((await read()).binding);
 await pool.query("UPDATE gl_accounts SET account_name='Changed synthetic classification evidence' WHERE company_id=$1 AND id=$2",[fixture.companyA,account]);
 expect(canonicalJson((await read()).binding)).not.toBe(before);
 try{await pool.query('UPDATE gl_accounts SET is_active=false WHERE company_id=$1 AND id=$2',[fixture.companyA,account]);await expect(read()).rejects.toThrow('account');}
 finally{await pool.query('UPDATE gl_accounts SET is_active=true WHERE company_id=$1 AND id=$2',[fixture.companyA,account]);}
 try{await pool.query("UPDATE companies SET default_currency='USD' WHERE id=$1",[fixture.companyA]);await expect(read()).rejects.toThrow('currency');}
 finally{await pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1",[fixture.companyA]);}
});
it('refuses revoked import authority and tampered source bytes metadata',async()=>{
 try{await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);await expect(actor('u1',ctx=>prepareHistoricalImport(ctx,prepare()))).rejects.toThrow();}
 finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);}
 const old=(await pool.query('SELECT content_hash FROM control_historical_import_sources WHERE company_id=$1 AND id=$2',[fixture.companyA,sourceId])).rows[0].content_hash;
 try{await pool.query('UPDATE control_historical_import_sources SET content_hash=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,sourceId,'a'.repeat(64)]);await expect(actor('u2',ctx=>readHistoricalImportSource(ctx,sourceId))).rejects.toThrow('unavailable or changed');}
 finally{await pool.query('UPDATE control_historical_import_sources SET content_hash=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,sourceId,old]);}
});
