import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {uuidBoundaryFixture,upper} from './uuidBoundaryFixture';
import {prepareAssetDepreciation,executeAssetDepreciation,type AssetDepreciationResult} from '@/modules/accounting/services/gl/controlledAssetDepreciation';
let f:Awaited<ReturnType<typeof uuidBoundaryFixture>>;
const category=randomUUID();
beforeAll(async()=>{
 f=await uuidBoundaryFixture();const company=f.f.companyA;
 await f.pool.query("UPDATE companies SET default_currency='ZAR',lockdown_enabled=false WHERE id=$1",[company]);
 for(const [code,type,subtype,normal] of [['UUID-DEP-E','expense','depreciation_expense','debit'],['UUID-DEP-A','asset','accumulated_depreciation','credit']])
  await f.pool.query(`INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level)
   VALUES($1,$2,$2,$3,$4,$5,true,true,3)`,[company,code,type,subtype,normal]);
 await f.pool.query(`INSERT INTO fiscal_periods(company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
  VALUES($1,'Synthetic UUID depreciation',2,2026,'2026-02-01','2026-02-28','open')`,[company]);
 await f.pool.query(`INSERT INTO asset_categories(id,name,code,sars_rate,sars_years,useful_life_years,tax_life_years,capitalization_threshold)
  VALUES($1,$2,$2,100,1,1,1,0)`,[category,`SYNTHETIC-UUID-${category}`]);
 await f.pool.query(`INSERT INTO approval_rules(company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
  VALUES($1,'Synthetic UUID depreciation approval','asset_depreciation','amount','any',0,'admin')`,[company]);
},60000);
afterAll(async()=>{await f?.close();});
async function prepared(){
 const asset=randomUUID();
 await f.pool.query(`INSERT INTO assets(id,company_id,category_id,asset_number,name,purchase_date,purchase_price,useful_life_years,tax_useful_life_years)
  VALUES($1,$2,$3,$4,'Synthetic UUID asset','2026-01-01',1200,1,1)`,[asset,f.f.companyA,category,`UUID-${asset.slice(0,8)}`]);
 const saved=await f.actor(()=>prepareAssetDepreciation(f.f.companyA,f.f.u1.id,asset,'2026-02-28'));
 expect(saved.requiresApproval).toBe(true);upper(saved.intentId);
 return{asset,...saved};
}
function execute(id:string,approvalId?:string){return f.actor(()=>executeAssetDepreciation(f.f.companyA,f.f.u1.id,id,approvalId?{approvalId}:undefined));}
async function population(intentId:string,asset:string){
 const journals=(await f.pool.query("SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source='auto_depreciation' AND source_record_id=$2::uuid ORDER BY id",[f.f.companyA,intentId])).rows;
 const totals=(await f.pool.query(`SELECT COALESCE(sum(l.debit),0)::text AS debit,COALESCE(sum(l.credit),0)::text AS credit FROM gl_journal_lines l
  JOIN gl_journal_entries j ON j.company_id=l.company_id AND j.id=l.journal_entry_id
  WHERE j.company_id=$1 AND j.source='auto_depreciation' AND j.source_record_id=$2::uuid AND j.status='posted'`,[f.f.companyA,intentId])).rows[0];
 const ledgers=(await f.pool.query('SELECT yyyymm FROM asset_period_ledger WHERE company_id=$1 AND asset_id=$2',[f.f.companyA,asset])).rows;
 const book=(await f.pool.query('SELECT accumulated_depreciation::text FROM assets WHERE company_id=$1 AND id=$2',[f.f.companyA,asset])).rows[0];
 return{journals,totals,ledgers,book,effects:await f.effects('asset_depreciation_intent','asset_depreciation.post',intentId)};
}
function expectOneDepreciation(saved:Awaited<ReturnType<typeof population>>,first:AssetDepreciationResult){
 expect(saved.journals).toEqual([{id:first.journalEntryId}]);expect(saved.effects).toHaveLength(1);
 expect(saved.totals).toEqual({debit:'100.00',credit:'100.00'});expect(saved.ledgers).toEqual([{yyyymm:'202602'}]);
 expect(Number(saved.book.accumulated_depreciation)).toBe(100);
}
it.each([false,true])('replays either UUID case after initial uppercase=%s depreciation without another approval',async uppercase=>{
 const p=await prepared(),approval=await f.approve(p.operation),caseVariant=upper(p.intentId);
 const first=await execute(uppercase?caseVariant:p.intentId,approval);
 expect(first.intentId).toBe(p.intentId);
 await expect(execute(p.intentId)).resolves.toEqual(first);
 await expect(execute(caseVariant)).resolves.toEqual(first);
 expectOneDepreciation(await population(p.intentId,p.asset),first);
});
it('cannot depreciate one asset period twice through an independently approved UUID case variant',async()=>{
 const p=await prepared(),first=await execute(p.intentId,await f.approve(p.operation));
 const second=await f.attempt(async()=>execute(upper(p.intentId),await f.approve({...p.operation,entityId:upper(p.intentId)})));
 expectOneDepreciation(await population(p.intentId,p.asset),first);
 if(second.value)expect(second.value).toEqual(first);else expect(second.error).toBeInstanceOf(Error);
});
it('serializes concurrently executed independently approved lower and uppercase depreciation to one effect',async()=>{
 const p=await prepared(),caseVariant={...p.operation,entityId:upper(p.intentId)};
 const lowerApproval=await f.approve(p.operation),upperApproval=await f.approve(caseVariant);
 const outcomes=await Promise.allSettled([execute(p.intentId,lowerApproval),execute(caseVariant.entityId,upperApproval)]);
 const fulfilled=outcomes.filter((o):o is PromiseFulfilledResult<AssetDepreciationResult>=>o.status==='fulfilled');
 expect(fulfilled).toHaveLength(1);
 expectOneDepreciation(await population(p.intentId,p.asset),fulfilled[0]!.value);
});
