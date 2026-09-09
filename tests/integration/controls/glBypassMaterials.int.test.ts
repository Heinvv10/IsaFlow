import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { previewDepreciationJournals } from '@/modules/accounting/services/items/depreciationRunPreview';
import type { DepreciationPlan } from '@/modules/accounting/services/items/depreciationRunPlan';
import { postDualDepreciationToLedger } from '@/modules/accounting/services/gl/assetDepreciationPosting';
import { prepareAssetDepreciation, executeAssetDepreciation } from '@/modules/accounting/services/gl/controlledAssetDepreciation';
import { prepareBankTransfer, executeBankTransfer } from '@/modules/accounting/services/bank/bankTransferPostingService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { materializeBankTransferOperation } from '@/modules/accounting/services/controls/bankTransferOperationMaterializer';
import { materializeAssetDepreciationOperation } from '@/modules/accounting/services/controls/assetDepreciationOperationMaterializer';
import { requestOperationApproval, decideOperationApproval } from '@/modules/accounting/services/controls/approvalRequestService';
import { replayKnownOperationEffect } from '@/modules/accounting/services/controls/operationReceiptReplay';
import { operationBindingHash } from '@/modules/accounting/services/controls/canonical';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2,statement_timeout:5000});
let fixture:ForensicFixture;
const bankIntent=randomUUID(),assetIntent=randomUUID(),asset=randomUUID(),period=randomUUID(),category=randomUUID();
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
 await pool.query(`INSERT INTO asset_categories(id,name,code,sars_rate,sars_years,useful_life_years,tax_life_years,capitalization_threshold)
  VALUES($1,$2,$2,100,1,1,1,0)`,[category,`SYNTHETIC-${category}`]);
 await pool.query(`INSERT INTO assets(id,company_id,category_id,asset_number,name,purchase_date,purchase_price,useful_life_years,tax_useful_life_years)
  VALUES($1,$2,$3,'SYNTHETIC','Synthetic asset','2026-01-01',1200,1,1)`,[asset,fixture.companyA,category]);
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
 const plan={postable:[{assetId:asset,assetNumber:'SYNTHETIC',name:'Synthetic asset'}],periodDate:'2026-02-28'} as unknown as DepreciationPlan;
 const preview=await actor('u2',()=>previewDepreciationJournals(fixture.companyA,plan,[{id:asset,cost:999999}]));
 expect(preview.journals[0]?.totalDebit).toBe(100);
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

it('prepares a durable bank intent without posting and executes it exactly once across new requests',async()=>{
 const prepared=await actor('u1',()=>prepareBankTransfer(fixture.companyA,fixture.u1.id,{fromAccountId:accounts[0]!.id,toAccountId:accounts[1]!.id,amount:'12.34',transferDate:'2026-02-28'}));
 expect(prepared).toMatchObject({status:'prepared',amount:'12.34',currency:'ZAR'});
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,prepared.intentId])).rows).toHaveLength(0);
 const posted=await actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId));
 expect(posted.status).toBe('posted');
 expect(await actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId))).toEqual(posted);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,prepared.intentId])).rows).toHaveLength(1);
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_transfer_intent' AND entity_id=$2",[fixture.companyA,prepared.intentId])).rows).toHaveLength(1);
 const effect=(await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_type='bank_transfer_intent' AND entity_id=$2",[fixture.companyA,prepared.intentId])).rows[0].id as string;
 await expect(actor('u3',ctx=>replayKnownOperationEffect(ctx,prepared.operation,effect))).rejects.toThrow('association');
 await expect(actor('u1',ctx=>replayKnownOperationEffect(ctx,{...prepared.operation,entityId:bankIntent},effect))).rejects.toThrow('association');
 await expect(actor('u2',()=>executeBankTransfer(fixture.companyA,fixture.u2.id,prepared.intentId))).rejects.toThrow('requester');
});
it('refuses inactive bank metadata and closed dates without leaving a financial journal',async()=>{
 const prepare=()=>actor('u1',()=>prepareBankTransfer(fixture.companyA,fixture.u1.id,{fromAccountId:accounts[0]!.id,toAccountId:accounts[1]!.id,amount:'23.45',transferDate:'2026-02-28'}));
 const prepared=await prepare();
 try{
  await pool.query('UPDATE bank_accounts SET is_active=false WHERE company_id=$1 AND gl_account_id=$2',[fixture.companyA,accounts[0]!.id]);
  await expect(actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId))).rejects.toThrow('inactive');
 }finally{await pool.query('UPDATE bank_accounts SET is_active=true WHERE company_id=$1 AND gl_account_id=$2',[fixture.companyA,accounts[0]!.id]);}
 try{
  await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);
  await expect(actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId))).rejects.toThrow();
 }finally{await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND id=$2",[fixture.companyA,period]);}
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,prepared.intentId])).rows).toHaveLength(0);
});

it('posts depreciation from persisted asset values and reuses the immutable asset period intent',async()=>{
 const prepared=await actor('u1',()=>prepareAssetDepreciation(fixture.companyA,fixture.u1.id,asset,'2026-02-28'));
 expect(prepared.amount).toBe('100');
 const result=await actor('u1',()=>executeAssetDepreciation(fixture.companyA,fixture.u1.id,prepared.intentId));
 expect(result).toMatchObject({policyDep:'100',taxDep:'100'});expect(result.journalEntryId).toBeTruthy();
 expect((await pool.query('SELECT entry_number FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,result.journalEntryId])).rows[0].entry_number).toBe('DEP-SYNTHETIC-2026-02');
 expect(await actor('u1',()=>executeAssetDepreciation(fixture.companyA,fixture.u1.id,prepared.intentId))).toEqual(result);
 const current=(await pool.query('SELECT accumulated_depreciation::text,tax_accumulated_depreciation::text FROM assets WHERE company_id=$1 AND id=$2',[fixture.companyA,asset])).rows[0];
 expect(current).toEqual({accumulated_depreciation:'100.00',tax_accumulated_depreciation:'100.00'});
 const another=await actor('u1',()=>prepareAssetDepreciation(fixture.companyA,fixture.u1.id,asset,'2026-02-28'));
 expect(another.intentId).toBe(prepared.intentId);
 expect(await actor('u1',()=>executeAssetDepreciation(fixture.companyA,fixture.u1.id,another.intentId))).toEqual(result);
 await expect(actor('u2',()=>prepareAssetDepreciation(fixture.companyA,fixture.u2.id,asset,'2026-02-28'))).rejects.toThrow('another requester');
 expect((await pool.query('SELECT id FROM asset_period_ledger WHERE company_id=$1 AND asset_id=$2',[fixture.companyA,asset])).rows).toHaveLength(1);
});

it('legacy dual-run entry point ignores forged caller financial amounts and reuses its exact persisted effect',async()=>{
 const result=await actor('u1',()=>postDualDepreciationToLedger(fixture.companyA,asset,{cost:999999,residualPct:0,usefulLifeYears:1,taxLifeYears:1,purchaseDate:'2020-01-01',periodDate:'2026-02-28',openingAccDep:0,taxOpeningAccDep:0,deferredTaxRate:0.99},'202602',fixture.u1.id));
 expect(result).toMatchObject({policyDep:100,taxDep:100,glFailed:false});
 expect((await pool.query('SELECT id FROM asset_period_ledger WHERE company_id=$1 AND asset_id=$2',[fixture.companyA,asset])).rows).toHaveLength(1);
 await expect(actor('u3',()=>postDualDepreciationToLedger(fixture.companyA,asset,{cost:1,residualPct:0,usefulLifeYears:1,taxLifeYears:1,purchaseDate:'2026-01-01',periodDate:'2026-02-28',openingAccDep:0,taxOpeningAccDep:0,deferredTaxRate:0},'202602',fixture.u3.id))).rejects.toThrow('match');
});

it('requires independent bank approval and refuses an approved transfer after bank metadata changes',async()=>{
 const rule=randomUUID();await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
  VALUES($1,$2,'Synthetic transfer approval','payment','amount','any',0,'admin')`,[rule,fixture.companyA]);
 const prepared=await actor('u1',()=>prepareBankTransfer(fixture.companyA,fixture.u1.id,{fromAccountId:accounts[0]!.id,toAccountId:accounts[1]!.id,amount:'45.67',transferDate:'2026-02-28'}));
 expect(prepared.requiresApproval).toBe(true);
 await expect(actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId))).rejects.toThrow('Independent operation approval is required');
 const approval=await actor('u1',ctx=>requestOperationApproval(ctx,prepared.operation));
 await actor('u2',ctx=>decideOperationApproval(ctx,approval.id,'approved'));
 try{
  await pool.query("UPDATE gl_accounts SET account_name='Changed synthetic bank' WHERE company_id=$1 AND id=$2",[fixture.companyA,accounts[0]!.id]);
  await expect(actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId,{approvalId:approval.id}))).rejects.toThrow('material');
 }finally{await pool.query("UPDATE gl_accounts SET account_name='Synthetic GL control' WHERE company_id=$1 AND id=$2",[fixture.companyA,accounts[0]!.id]);}
 const posted=await actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId,{approvalId:approval.id}));
 expect(posted).toMatchObject({status:'posted',amount:'45.67'});
 expect(await actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId,{approvalId:approval.id}))).toEqual(posted);
 try{
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
  await expect(actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId))).rejects.toThrow('authority');
  await expect(actor('u1',()=>executeBankTransfer(fixture.companyA,fixture.u1.id,prepared.intentId,{approvalId:approval.id}))).rejects.toThrow('authority');
 }finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);}

});

it('refuses zero-book nonzero-tax depreciation inside company lockdown without ledger mutation',async()=>{
 const zeroAsset=randomUUID();
 await pool.query(`INSERT INTO assets(id,company_id,category_id,asset_number,name,purchase_date,purchase_price,useful_life_years,tax_useful_life_years,accumulated_depreciation,current_book_value,tax_accumulated_depreciation)
  VALUES($1,$2,$3,'SYNTHETIC-ZERO','Synthetic fully book-depreciated asset','2026-01-01',1200,1,1,1200,0,0)`,[zeroAsset,fixture.companyA,category]);
 const prepared=await actor('u1',()=>prepareAssetDepreciation(fixture.companyA,fixture.u1.id,zeroAsset,'2026-02-28'));
 expect(prepared.amount).toBe('0');
 try{
  await pool.query("UPDATE companies SET lockdown_enabled=true,lockdown_date='2026-02-28' WHERE id=$1",[fixture.companyA]);
  await expect(actor('u1',()=>executeAssetDepreciation(fixture.companyA,fixture.u1.id,prepared.intentId))).rejects.toThrow('lockdown');
 }finally{await pool.query('UPDATE companies SET lockdown_enabled=false,lockdown_date=NULL WHERE id=$1',[fixture.companyA]);}
 expect((await pool.query('SELECT id FROM asset_period_ledger WHERE company_id=$1 AND asset_id=$2',[fixture.companyA,zeroAsset])).rows).toHaveLength(0);
 expect((await pool.query('SELECT tax_accumulated_depreciation::text AS amount FROM assets WHERE company_id=$1 AND id=$2',[fixture.companyA,zeroAsset])).rows[0].amount).toBe('0.00');
});

it('refuses a repeat preview after a zero-policy tax-only subledger posting',async()=>{
 const zeroAsset=randomUUID();
 await pool.query(`INSERT INTO assets(id,company_id,category_id,asset_number,name,purchase_date,purchase_price,useful_life_years,tax_useful_life_years,accumulated_depreciation,current_book_value,tax_accumulated_depreciation)
  VALUES($1,$2,$3,'SYNTHETIC-ZERO-REPEAT','Synthetic tax-only asset','2026-01-01',1200,1,1,1200,0,0)`,[zeroAsset,fixture.companyA,category]);
 const plan={postable:[{assetId:zeroAsset,assetNumber:'FORGED',name:'Forged'}],periodDate:'2026-02-28'} as unknown as DepreciationPlan;
 expect((await actor('u1',()=>previewDepreciationJournals(fixture.companyA,plan,[]))).writesWithoutJournal).toHaveLength(1);
 const prepared=await actor('u1',()=>prepareAssetDepreciation(fixture.companyA,fixture.u1.id,zeroAsset,'2026-02-28'));
 await actor('u1',()=>executeAssetDepreciation(fixture.companyA,fixture.u1.id,prepared.intentId));
 await expect(actor('u1',()=>previewDepreciationJournals(fixture.companyA,plan,[]))).rejects.toThrow('Depreciation period already exists');
 expect((await pool.query('SELECT id FROM asset_period_ledger WHERE company_id=$1 AND asset_id=$2',[fixture.companyA,zeroAsset])).rows).toHaveLength(1);
 expect((await pool.query('SELECT tax_accumulated_depreciation::text AS amount FROM assets WHERE company_id=$1 AND id=$2',[fixture.companyA,zeroAsset])).rows[0].amount).toBe('100.00');
});
