import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({prepare:vi.fn(async()=>({intentId:'intent'})),execute:vi.fn(async()=>({intentId:'intent',journalEntryId:'journal',policyDep:'100',taxDep:'100'})),sql:vi.fn(async()=>[])}));
vi.mock('@/modules/accounting/services/gl/controlledAssetDepreciation',()=>({prepareAssetDepreciation:mocks.prepare,executeAssetDepreciation:mocks.execute}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql,withSavepoint:vi.fn(async(_name:string,fn:()=>Promise<unknown>)=>fn())}));
vi.mock('@/lib/logger',()=>({log:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}}));
import {postDualDepreciationToLedger} from '@/modules/accounting/services/gl/assetDepreciationPosting';
beforeEach(()=>vi.clearAllMocks());
it('routes legacy dual runs through persisted-source controls instead of writing caller supplied amounts',async()=>{
 const result=await postDualDepreciationToLedger('company','asset',{cost:999999,residualPct:0,usefulLifeYears:1,taxLifeYears:1,purchaseDate:'2026-01-01',periodDate:'2026-02-28',openingAccDep:0,taxOpeningAccDep:0,deferredTaxRate:0.27},'202602','person');
 expect(mocks.prepare).toHaveBeenCalledWith('company','person','asset','2026-02-28');
 expect(mocks.execute).toHaveBeenCalledWith('company','person','intent',undefined);
 expect(result).toMatchObject({policyDep:100,taxDep:100,entryId:'journal',glFailed:false});
 expect(mocks.sql).not.toHaveBeenCalled();
});
it('refuses inconsistent month keys before preparing an intent',async()=>{
 await expect(postDualDepreciationToLedger('company','asset',{cost:1200,residualPct:0,usefulLifeYears:1,taxLifeYears:1,purchaseDate:'2026-01-01',periodDate:'2026-02-28',openingAccDep:0,taxOpeningAccDep:0,deferredTaxRate:0.27},'202601','person')).rejects.toThrow('month');
 expect(mocks.prepare).not.toHaveBeenCalled();
});
