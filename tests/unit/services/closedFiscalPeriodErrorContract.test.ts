/** Actual shared-writer throws are verified in gl39Posting.int.test.ts (GL01-04). */
import {expect,it} from 'vitest';
import {ClosedFiscalPeriodError,postJournalEntry} from '@/modules/accounting/services/gl/journalEntryPostingService';
it.each(['closed','locked'])('exported %s period error retains actionable status and Error identity',status=>{
 const error=new ClosedFiscalPeriodError(status);expect(error).toBeInstanceOf(Error);expect(error.name).toBe('ClosedFiscalPeriodError');expect(error.periodStatus).toBe(status);expect(error.message).toContain(status);
});
it('a direct unissued post is refused before any database work',async()=>{
 await expect(postJournalEntry('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333')).rejects.toThrow('Authenticated control transaction required');
});
