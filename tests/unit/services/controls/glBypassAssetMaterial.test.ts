import { expect, it, vi } from 'vitest';
vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/operationVersions', () => ({ readControlEntityVersion: vi.fn(async () => null) }));
import { materializeAssetDepreciationOperation } from '@/modules/accounting/services/controls/assetDepreciationOperationMaterializer';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
const id='11111111-1111-1111-1111-111111111111';
const ref:OperationRef={entityType:'asset_depreciation_intent',entityId:id,operation:'asset_depreciation.post'};
function context(overrides:Record<string,unknown>={}) {
 const data={company:{id,default_currency:'ZAR'},intent:{id,asset_id:id,period_date:'2026-02-28'},
  asset:{id,asset_number:'ASSET1',purchase_price:'1200',purchase_date:'2026-01-01',accumulated_depreciation:'0',tax_accumulated_depreciation:'0',useful_life_years:1,tax_useful_life_years:1,deferred_tax_rate:'0.27',status:'available',below_threshold:false},
  ledgers:[],accounts:[{id:'expense',account_type:'expense',account_subtype:'depreciation_expense',is_active:true,is_system_account:true},
   {id:'accumulated',account_type:'asset',account_subtype:'accumulated_depreciation',is_active:true,is_system_account:true}],periods:[{id:'period',status:'open'}],...overrides};
 const sql=vi.fn(async(strings:TemplateStringsArray)=>{
  const query=strings.join('?');
  if(query.includes('FROM companies'))return [data.company];
  if(query.includes('FROM control_asset_depreciation_intents'))return [data.intent];
  if(query.includes('FROM assets'))return [data.asset];
  if(query.includes('FROM asset_period_ledger'))return data.ledgers;
  if(query.includes('FROM gl_accounts'))return data.accounts;
  if(query.includes('FROM fiscal_periods'))return data.periods;
  throw new Error('Unexpected SQL');
 });
 return {principal:{companyId:id},sql} as unknown as ControlTx;
}
it('derives depreciation from locked persisted source facts, never a caller amount',async()=>{
 const result=await materializeAssetDepreciationOperation(context(),ref);
 expect(result.binding).toMatchObject({amount:'100',currency:'ZAR',accountingDate:'2026-02-28'});
 expect(result.observedSources[0]!.facts).toMatchObject({calculation:{policyDep:'100',taxDep:'100'}});
});
it('refuses unresolved account roles and unbounded ledger history',async()=>{
 await expect(materializeAssetDepreciationOperation(context({accounts:[]}),ref)).rejects.toThrow();
 await expect(materializeAssetDepreciationOperation(context({ledgers:Array.from({length:10001},()=>({}))}),ref)).rejects.toThrow();
});
