import {expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({permission:vi.fn(),sql:vi.fn(async()=>[{id:'company',default_currency:'ZAR'}]),facts:vi.fn(async()=>({company:{id:'company'},asset:{id:'asset',name:'Persisted asset',asset_number:'OWNED'},ledgers:[] as Record<string,unknown>[],intent:{},calculation:{policyDep:'100',taxDep:'100'},plan:[{glAccountId:'expense',debit:'100',credit:'0'},{glAccountId:'accumulated',debit:'0',credit:'100'}],accounts:[{id:'expense',account_code:'5001',account_name:'Expense',is_active:true},{id:'accumulated',account_code:'1501',account_name:'Accumulated',is_active:true}],period:{id:'period',status:'open'}}))}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>({principal:{companyId:'company'},sql:mocks.sql}),assertControlTx:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/assetDepreciationOperationMaterializer',()=>({loadAssetDepreciationFacts:mocks.facts}));
import {previewDepreciationJournals} from '@/modules/accounting/services/items/depreciationRunPreview';
import type {DepreciationPlan} from '@/modules/accounting/services/items/depreciationRunPlan';
it('previews persisted exact values rather than the caller plan financial inputs',async()=>{
 const row={assetId:'asset',assetNumber:'SYNTHETIC',name:'Asset'};
 const plan={postable:[row],periodDate:'2026-02-28',fiscalPeriodId:'period'} as unknown as DepreciationPlan;
 const preview=await previewDepreciationJournals('company',plan,[{id:'asset',cost:999999,useful_life_years:1,purchase_date:'2020-01-01'}]);
 expect(mocks.permission).toHaveBeenCalledWith(expect.anything(),'read:assets');
 expect(preview.journals[0]?.lines[0]?.debit).toBe(100);
 expect(mocks.facts).toHaveBeenCalledOnce();
});

it('refuses preview after an existing zero-policy target subledger effect',async()=>{
 const facts=await mocks.facts();
 mocks.facts.mockResolvedValueOnce({...facts,plan:[],ledgers:[{yyyymm:202602}],calculation:{policyDep:'0',taxDep:'100'}});
 const plan={postable:[{assetId:'asset',assetNumber:'FORGED',name:'Forged'}],periodDate:'2026-02-28'} as unknown as DepreciationPlan;
 await expect(previewDepreciationJournals('company',plan,[])).rejects.toThrow('Depreciation period already exists');
});
it('describes the persisted asset rather than caller labels',async()=>{
 const plan={postable:[{assetId:'asset',assetNumber:'FORGED',name:'Forged'}],periodDate:'2026-02-28'} as unknown as DepreciationPlan;
 const preview=await previewDepreciationJournals('company',plan,[]);
 expect(preview.journals[0]?.description).toBe('Depreciation: Persisted asset (OWNED)');
});
