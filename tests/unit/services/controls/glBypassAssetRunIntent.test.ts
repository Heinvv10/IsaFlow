import {expect,it,vi} from 'vitest';
vi.mock('@/modules/accounting/services/gl/glCrossModuleHooks',()=>({postDualDepreciationToLedger:vi.fn(async()=>({policyDep:0,taxDep:0,entryId:null,glFailed:true,intentId:'pending-intent',requiresApproval:true}))}));
import {executeDepreciationRun,type DepreciationPlan} from '@/modules/accounting/services/items/depreciationRunService';
it('returns the durable review intent when an asset run needs approval',async()=>{
 const row={assetId:'asset',assetNumber:'SYNTHETIC'};
 const plan={periodDate:'2026-02-28',yyyymm:'202602',rows:[row],postable:[row],eligibleTotal:1} as unknown as DepreciationPlan;
 const result=await executeDepreciationRun('company','person',plan,[{id:'asset',purchase_date:'2026-01-01'}]);
 expect(result.results[0]).toMatchObject({intentId:'pending-intent',requiresApproval:true,entryId:null});
 expect(result).toMatchObject({processed:0,glFailed:1});
});
