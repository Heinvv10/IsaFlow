import { beforeEach, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({require:vi.fn(),sql:vi.fn(async()=>[]),execute:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mock.require}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({executeControlledOperation:mock.execute}));
vi.mock('@/modules/accounting/services/payroll/payrollPostingReceipt',()=>({readPayrollPostingReceipt:vi.fn(async()=>null)}));
vi.mock('@/lib/neon',()=>({sql:mock.sql}));
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { postPayrollRunJournal, reversePayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';
beforeEach(()=>{vi.clearAllMocks();mock.require.mockImplementation(()=>{throw new Error('Authenticated context required');});});
it.each([
  ['approve',approvePayrollRun],['post',postPayrollRunJournal],['reverse',reversePayrollRunJournal],
] as const)('requires authenticated context before %s accesses financial data',async(_name,call)=>{
  await expect(call('company','run','user')).rejects.toThrow('Authenticated context');
  expect(mock.sql).not.toHaveBeenCalled();
});
it('rejects a forged person before the execution kernel',async()=>{
  mock.require.mockReturnValue({principal:{personId:'real',companyId:'company'}});
  await expect(approvePayrollRun('company','run','forged')).rejects.toThrow('match');
  expect(mock.execute).not.toHaveBeenCalled();
});
it('uses one canonical posting operation for approval and direct journal posting',async()=>{
  mock.require.mockReturnValue({principal:{personId:'user',companyId:'company'}});
  mock.execute.mockResolvedValue({run:{id:'run',status:'approved'},journalEntryId:'journal'});
  expect(await approvePayrollRun('company','run','user')).toMatchObject({journalEntryId:'journal'});
  expect(await postPayrollRunJournal('company','run','user')).toBe('journal');
  for(const call of mock.execute.mock.calls) expect(call[1]).toMatchObject({entityType:'payroll_run',operation:'payroll_run.post'});
});
it('requires authenticated context before calculation can apply loan or line mutations',async()=>{
  const {calculatePayrollRun}=await import('@/modules/accounting/services/payroll/payrollRunService');
  await expect(calculatePayrollRun('run','company')).rejects.toThrow('Authenticated context');
  expect(mock.sql).not.toHaveBeenCalled();
});
it('requires authenticated context before reopening a run',async()=>{
  const {reopenPayrollRun}=await import('@/modules/accounting/services/payroll/payrollRunLock');
  await expect(reopenPayrollRun({runId:'run',companyId:'company',userId:'user',reason:'correction'})).rejects.toThrow('Authenticated context');
  expect(mock.sql).not.toHaveBeenCalled();
});
it('rejects oversized reopen reasons before accessing payroll data',async()=>{
  const {reopenPayrollRun}=await import('@/modules/accounting/services/payroll/payrollRunLock');
  await expect(reopenPayrollRun({runId:'run',companyId:'company',userId:'user',reason:'x'.repeat(2001)})).rejects.toThrow('2000');
  expect(mock.sql).not.toHaveBeenCalled();
});
