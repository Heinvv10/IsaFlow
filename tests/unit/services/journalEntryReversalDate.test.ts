/**
 * Date policy tests run the real helper; persisted period/contra assertions are gl39Reversal PG.
 *
 * The helper is the pre-write guard the MCP reverse tool and bankAllocationService run before they
 * reach the controls kernel (the kernel re-derives the same policy in SQL off the DB clock, where
 * only an integration test can see it — k010/k021 reversal suites). What used to be asserted here
 * by driving reverseJournalEntry with a mocked crud service is no longer reachable: the reversal is
 * a single controlled operation now, so there is no separately-created draft to delete and no claim
 * to release on a failed post; k021-failed-reversal-commits-unwind covers that unwinding for real.
 */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
vi.mock('@/modules/accounting/services/gl/periodStatusService',()=>({getPeriodStatusForDate:vi.fn()}));
import {getPeriodStatusForDate} from '@/modules/accounting/services/gl/periodStatusService';
import {resolveReversalDate,ReversalPeriodError} from '@/modules/accounting/services/gl/journalEntryReversalDate';
import {fmtDate} from '@/lib/fmtDate';
const company='11111111-1111-4111-8111-111111111111',original='2026-03-15';
beforeEach(()=>{vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-10T10:00:00+02:00'));});
afterEach(()=>vi.useRealTimers());
it('default uses original accounting date and queries its owned period',async()=>{
 vi.mocked(getPeriodStatusForDate).mockResolvedValue('open');expect(await resolveReversalDate(company,original,undefined)).toBe(original);expect(getPeriodStatusForDate).toHaveBeenCalledExactlyOnceWith(company,original);
});
it.each(['closed','no_period'] as const)('default falls back to today for original %s period',async status=>{
 vi.mocked(getPeriodStatusForDate).mockResolvedValue(status);expect(await resolveReversalDate(company,original,undefined)).toBe('2026-09-10');
});
it('local-midnight Date is formatted before the real date policy',async()=>{
 vi.mocked(getPeriodStatusForDate).mockResolvedValue('open');expect(await resolveReversalDate(company,fmtDate(new Date('2026-03-15T00:00:00+02:00')),undefined)).toBe(original);
});
it('explicit date checks only the target period even when the original period would be closed',async()=>{
 vi.mocked(getPeriodStatusForDate).mockImplementation(async(_company,date)=>date===original?'closed':'open');
 expect(await resolveReversalDate(company,original,'2026-04-10')).toBe('2026-04-10');expect(getPeriodStatusForDate).toHaveBeenCalledExactlyOnceWith(company,'2026-04-10');
});
it('explicit original date is valid',async()=>{vi.mocked(getPeriodStatusForDate).mockResolvedValue('open');expect(await resolveReversalDate(company,original,original)).toBe(original);});
it.each([['no_period','No fiscal period'],['closed','closed']] as const)('target %s gives actionable refusal',async(status,message)=>{
 // The CLASS is load-bearing: soft-delete.ts decides 400-vs-500 on `instanceof`, so a plain Error
 // here answers an unrelated fault as a user problem carrying the raw internal message.
 vi.mocked(getPeriodStatusForDate).mockResolvedValue(status);await expect(resolveReversalDate(company,original,'2026-04-10')).rejects.toThrow(message);
 vi.mocked(getPeriodStatusForDate).mockResolvedValue(status);await expect(resolveReversalDate(company,original,'2026-04-10')).rejects.toBeInstanceOf(ReversalPeriodError);
});
it('earlier target refuses before any period query',async()=>{await expect(resolveReversalDate(company,original,'2026-03-14')).rejects.toThrow('before the entry');expect(getPeriodStatusForDate).not.toHaveBeenCalled();});
it.each(['not-a-date','2026-02-30','15/07/2026','2026-7-5','today','','2026-13-01'])('malformed target %s refuses without queries',async date=>{await expect(resolveReversalDate(company,original,date)).rejects.toThrow('YYYY-MM-DD');expect(getPeriodStatusForDate).not.toHaveBeenCalled();});
