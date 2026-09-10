import {beforeEach,expect,it,vi} from 'vitest';
import {IMPERSONATION_UNVERIFIED} from '@/lib/auth/impersonationState';

const mocks=vi.hoisted(()=>({sql:vi.fn(),impersonator:vi.fn<[],string|null>(()=>null)}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql}));
vi.mock('@/modules/accounting/services/controls/independentReview',async()=>({
 requestImpersonator:mocks.impersonator,
 assertIndependentRequestReview:vi.fn(),
}));
import {approveCommentary,rejectCommentary} from '@/modules/accounting/services/commentary/commentaryService';

const id='44444444-4444-4444-8444-444444444444',companyId='55555555-5555-4555-8555-555555555555';
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.impersonator.mockReturnValue(null);
 mocks.sql.mockImplementation(async()=>[{id,section_ref:'balance_sheet',row_ref:'equity',draft_text:'A sentence',
  status:'draft',approved_text:null,approved_by:null,approved_at:null,withdrawn_by:null,withdrawn_at:null}]);
});

/** A text column meant for a user id must never hold a marker that joins to nothing. */
it('refuses to sign off when the impersonation state could not be established',async()=>{
 mocks.impersonator.mockReturnValue(IMPERSONATION_UNVERIFIED);
 await expect(approveCommentary(companyId,id,'reviewer')).rejects.toThrow(/impersonation state/i);
 expect(mocks.sql.mock.calls.some(call=>String((call[0] as string[]).join('')).includes('UPDATE report_commentary'))).toBe(false);
});
it('refuses to reject when the impersonation state could not be established',async()=>{
 mocks.impersonator.mockReturnValue(IMPERSONATION_UNVERIFIED);
 await expect(rejectCommentary(companyId,id,'reviewer')).rejects.toThrow(/impersonation state/i);
});
it('still signs off an ordinary session',async()=>{
 const result=await approveCommentary(companyId,id,'reviewer');
 expect(result.ok).toBe(true);
});
