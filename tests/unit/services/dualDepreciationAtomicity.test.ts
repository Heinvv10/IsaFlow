/** Legacy adapters surface controlled transaction outcomes; rollback itself has actual PG proof. */
import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({prepare:vi.fn(),execute:vi.fn()}));
vi.mock('@/modules/accounting/services/gl/controlledAssetDepreciation',()=>({prepareAssetDepreciation:m.prepare,executeAssetDepreciation:m.execute}));
vi.mock('@/lib/logger',()=>({log:{warn:vi.fn()}}));
import {postDualDepreciationToLedger} from '@/modules/accounting/services/gl/assetDepreciationPosting';
const input={cost:999999,residualPct:0,usefulLifeYears:3,taxLifeYears:3,purchaseDate:'2026-01-01',periodDate:'2026-07-31',openingAccDep:0,taxOpeningAccDep:0,deferredTaxRate:0.27};
const run=()=>postDualDepreciationToLedger('company','asset',input,'202607','user');
beforeEach(()=>{vi.resetAllMocks();m.prepare.mockResolvedValue({intentId:'intent',requiresApproval:false});});
it('reports the shared committed result and never forwards caller financial amounts',async()=>{
 m.execute.mockResolvedValue({policyDep:'100',taxDep:'90',journalEntryId:'journal'});
 expect(await run()).toMatchObject({policyDep:100,taxDep:90,entryId:'journal',glFailed:false});
 expect(m.prepare).toHaveBeenCalledWith('company','user','asset','2026-07-31');
 expect(m.execute).toHaveBeenCalledWith('company','user','intent',undefined);
});
it('reports a rolled-back shared writer failure loudly with no successful amounts',async()=>{
 m.execute.mockRejectedValue(new Error('Subledger constraint failure'));
 expect(await run()).toEqual({policyDep:0,taxDep:0,entryId:null,glFailed:true,intentId:'intent',requiresApproval:false});
});
it('returns the shared verified receipt on an idempotent retry',async()=>{
 m.execute.mockResolvedValue({policyDep:'100',taxDep:'90',journalEntryId:'existing'});
 expect(await run()).toMatchObject({entryId:'existing',glFailed:false});
});
it('surfaces a reversed receipt refusal rather than declaring already posted',async()=>{
 m.execute.mockRejectedValue(new Error('Depreciation receipt journal changed'));
 expect(await run()).toMatchObject({entryId:null,glFailed:true});
});
it('does not swallow preparation authority failures',async()=>{
 m.prepare.mockRejectedValue(new Error('Current authority required'));
 await expect(run()).rejects.toThrow('authority');expect(m.execute).not.toHaveBeenCalled();
});
