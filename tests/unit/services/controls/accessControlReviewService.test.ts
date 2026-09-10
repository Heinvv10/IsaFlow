import {expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const metadata=vi.hoisted(()=>vi.fn());
vi.mock('@/modules/accounting/services/controls/accessControlReviewMetadata',()=>({readAccessReviewMetadata:metadata}));
import {reviewAccessControl} from '@/modules/accounting/services/controls/accessControlReviewService';
it('retains independent population census on empty pages and discloses live coverage',async()=>{
 metadata.mockResolvedValue({populationTotal:42,evaluatedAt:'2026-09-10T01:00:00Z',subjects:[]});
 const result=await reviewAccessControl({principal:{companyId:'11111111-1111-4111-8111-111111111111'}} as ControlTx,{kind:'pat'});
 expect(result).toMatchObject({populationTotal:42,returnedCount:0,nextCursor:null,coverage:{mode:'live_pagination'},findingCountsForPage:{}});
 expect(result).not.toHaveProperty('completeHistoricalPopulation');
});
