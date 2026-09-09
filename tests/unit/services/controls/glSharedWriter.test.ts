import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({require:vi.fn(),sql:vi.fn(),get:vi.fn(),execute:vi.fn(),material:vi.fn(),assertGenerated:vi.fn(),register:vi.fn()}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql,withSavepoint:async (_:string,fn:()=>unknown)=>fn()}));
vi.mock('@/lib/logger',()=>({log:{info:vi.fn(),error:vi.fn()}}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mocks.require,assertControlTx:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/glOperationMaterializer',()=>({materializeGlOperation:mocks.material}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({executeControlledOperation:mocks.execute}));
vi.mock('@/modules/accounting/services/controls/generatedJournalPermit',()=>({assertGeneratedJournal:mocks.assertGenerated,registerGeneratedJournal:mocks.register}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/approvalRequestService',()=>({initializeOperationObservations:vi.fn()}));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService',()=>({getJournalEntryById:mocks.get,resolveUserUuid:vi.fn(),mapEntryRow:(r:unknown)=>r,createJournalEntry:vi.fn()}));
import { postJournalEntry,reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
const id='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{vi.clearAllMocks();mocks.get.mockResolvedValue(null);mocks.require.mockImplementation(()=>{throw new Error('Authenticated control transaction required');});});
it.each([postJournalEntry,reverseJournalEntry])('requires authenticated context before any journal access',async writer=>{
  await expect(writer('company',id,'person')).rejects.toThrow('Authenticated control transaction required');
  expect(mocks.get).not.toHaveBeenCalled();expect(mocks.sql).not.toHaveBeenCalled();
});
it('rejects a forged supplied person before dispatch',async()=>{
  mocks.require.mockReturnValue({principal:{companyId:'company',personId:'real-person'}});
  await expect(postJournalEntry('company',id,'person')).rejects.toThrow(/context/i);
  expect(mocks.execute).not.toHaveBeenCalled();
});
it('hands an ordinary posting to the shared execution gate before its effect',async()=>{
  const ctx={principal:{companyId:'company',personId:'person'}};mocks.require.mockReturnValue(ctx);
  mocks.execute.mockRejectedValue(new Error('Independent operation approval is required'));
  await expect(postJournalEntry('company',id,'person')).rejects.toThrow('approval');
  expect(mocks.execute).toHaveBeenCalledWith(ctx,{entityType:'journal_entry',entityId:id,operation:'journal.post'},null,expect.any(Function));
  expect(mocks.sql).not.toHaveBeenCalled();
});

function material(overrides:Record<string,unknown>={}) {
  return {binding:{entityId:id,entityVersion:1,accountingDate:'2026-09-09'},observedSources:[{entityType:'journal_entry',entityId:id,
    facts:{header:{status:'draft'},targetPeriod:{status:'open'},company:{lockdown_enabled:false},accounts:[{is_active:true}],...overrides}}]};
}
it.each([
  {targetPeriod:{status:'closed'}}, {accounts:[{is_active:false,account_code:'TEST',account_name:'Inactive'}]},
  {company:{lockdown_enabled:true,lockdown_date:'2026-09-09'}}, {header:{status:'posted'}},
])('keeps period, inactive-account, lockdown and status refusals before posting SQL',async state=>{
  const ctx={principal:{companyId:'company',personId:'person'},sql:mocks.sql};mocks.require.mockReturnValue(ctx);
  mocks.execute.mockImplementation(async (_ctx,_ref,_approval,effect)=>effect({}));mocks.material.mockResolvedValue(material(state));
  await expect(postJournalEntry('company',id,'person')).rejects.toThrow();expect(mocks.sql).not.toHaveBeenCalled();
});
it('posts only after material guards and execution approval, stamping the authenticated person',async()=>{
  const ctx={principal:{companyId:'company',personId:'person'},sql:mocks.sql};mocks.require.mockReturnValue(ctx);
  mocks.execute.mockImplementation(async (_ctx,_ref,_approval,effect)=>effect({}));mocks.material.mockResolvedValue(material());
  mocks.sql.mockResolvedValue([{id,status:'posted'}]);
  expect(await postJournalEntry('company',id,'person',{approvalId:'approved-intent'})).toEqual({id,status:'posted'});
  expect(mocks.execute.mock.calls[0]?.[2]).toBe('approved-intent');expect(mocks.sql).toHaveBeenCalledOnce();
});
