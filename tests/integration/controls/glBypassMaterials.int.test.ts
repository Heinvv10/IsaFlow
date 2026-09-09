import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { materializeBankTransferOperation } from '@/modules/accounting/services/controls/bankTransferOperationMaterializer';
import { materializeAssetDepreciationOperation } from '@/modules/accounting/services/controls/assetDepreciationOperationMaterializer';
import { operationBindingHash } from '@/modules/accounting/services/controls/canonical';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:5000});
let fixture:ForensicFixture;
const bankIntent=randomUUID(),assetIntent=randomUUID(),asset=randomUUID(),period=randomUUID();
const accounts=[['1001','asset','bank'],['1002','asset','bank'],['5001','expense','depreciation_expense'],['1501','asset','accumulated_depreciation']]
 .map(([code,type,subtype])=>({id:randomUUID(),code,type,subtype}));
const bankRef={entityType:'bank_transfer_intent',entityId:bankIntent,operation:'bank_transfer.post' as const};
const assetRef={entityType:'asset_depreciation_intent',entityId:assetIntent,operation:'asset_depreciation.post' as const};
async function actor<T>(person:'u1'|'u2'|'u3',fn:(ctx:ControlTx)=>Promise<T>):Promise<T>{
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,company_id:user.companyId,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims},
   {personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  if((await client.query('COMMIT')).command!=='COMMIT')throw new Error('Transaction did not commit');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 await pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[fixture.companyA]);
 for(const a of accounts)await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
  VALUES($1,$2,$3,'Synthetic GL control',$4,$5,'debit',true,true,3)`,[a.id,fixture.companyA,a.code,a.type,a.subtype]);
 for(const a of accounts.slice(0,2))await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic bank',$2,'ZAR')",[fixture.companyA,a.id]);
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
  VALUES($1,$2,'Synthetic GL period',2,2026,'2026-02-01','2026-02-28','open')`,[period,fixture.companyA]);
 await pool.query(`INSERT INTO assets(id,company_id,asset_number,name,purchase_date,purchase_price,useful_life_years,tax_useful_life_years)
  VALUES($1,$2,'SYNTHETIC','Synthetic asset','2026-01-01',1200,1,1)`,[asset,fixture.companyA]);
 await actor('u1',async ctx=>{
  await ctx.sql`INSERT INTO control_bank_transfer_intents(company_id,id,requester_person_id,from_gl_account_id,to_gl_account_id,amount,accounting_date)
   VALUES(${fixture.companyA}::uuid,${bankIntent}::uuid,${fixture.u1.id},${accounts[0]!.id}::uuid,${accounts[1]!.id}::uuid,100.01,'2026-02-28')`;
  await ctx.sql`INSERT INTO control_asset_depreciation_intents(company_id,id,requester_person_id,asset_id,period_date)
   VALUES(${fixture.companyA}::uuid,${assetIntent}::uuid,${fixture.u1.id},${asset}::uuid,'2026-02-28')`;
 });
});
afterAll(async()=>{await pool.end();});
const hash=(m:Awaited<ReturnType<typeof materializeBankTransferOperation>>)=>operationBindingHash({...m.binding,policies:[]});
it('reads exact bank and depreciation material as an independent approver without financial writes',async()=>{
 expect((await actor('u2',ctx=>materializeBankTransferOperation(ctx,bankRef))).binding).toMatchObject({amount:'100.01',currency:'ZAR'});
 expect((await actor('u2',ctx=>materializeAssetDepreciationOperation(ctx,assetRef))).binding).toMatchObject({amount:'100',currency:'ZAR'});
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
 expect((await pool.query('SELECT id FROM control_change_events WHERE company_id=$1',[fixture.companyA])).rows).toHaveLength(0);
});
it('refuses foreign intents and unknown bank currency',async()=>{
 await expect(actor('u3',ctx=>materializeBankTransferOperation(ctx,bankRef))).rejects.toThrow();
 await expect(actor('u3',ctx=>materializeAssetDepreciationOperation(ctx,assetRef))).rejects.toThrow();
 try{await pool.query("UPDATE bank_accounts SET currency='USD' WHERE company_id=$1 AND gl_account_id=$2",[fixture.companyA,accounts[0]!.id]);
  await expect(actor('u1',ctx=>materializeBankTransferOperation(ctx,bankRef))).rejects.toThrow('currency');
 }finally{await pool.query("UPDATE bank_accounts SET currency='ZAR' WHERE company_id=$1 AND gl_account_id=$2",[fixture.companyA,accounts[0]!.id]);}
});
it('changes fingerprints when source account, fiscal period or asset values change',async()=>{
 const originalBank=hash(await actor('u1',ctx=>materializeBankTransferOperation(ctx,bankRef)));
 const originalAsset=hash(await actor('u1',ctx=>materializeAssetDepreciationOperation(ctx,assetRef)));
 try{await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
  expect(hash(await actor('u1',ctx=>materializeBankTransferOperation(ctx,bankRef)))).not.toBe(originalBank);
 }finally{await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);}
 try{await pool.query('UPDATE assets SET purchase_price=2400 WHERE company_id=$1 AND id=$2',[fixture.companyA,asset]);
  expect(hash(await actor('u1',ctx=>materializeAssetDepreciationOperation(ctx,assetRef)))).not.toBe(originalAsset);
 }finally{await pool.query('UPDATE assets SET purchase_price=1200 WHERE company_id=$1 AND id=$2',[fixture.companyA,asset]);}
});
