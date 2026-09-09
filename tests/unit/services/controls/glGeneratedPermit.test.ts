import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({assert:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({assertControlledEffectPermit:mocks.assert}));
import { registerGeneratedJournal, assertGeneratedJournal } from '@/modules/accounting/services/controls/generatedJournalPermit';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
import type { ControlledEffectPermit } from '@/modules/accounting/services/controls/approvalExecutionService';
const journal='11111111-1111-4111-8111-111111111111';
const parent={entityType:'supplier_invoice',entityId:journal,operation:'supplier_invoice.post'} as OperationRef;
const permit={} as ControlledEffectPermit, control={permit,parent};
const ctx={principal:{}} as ControlTx;
beforeEach(()=>vi.clearAllMocks());
it('refuses an unregistered journal even inside a valid parent callback',()=>{
  expect(()=>assertGeneratedJournal(ctx,control,journal,'journal.post')).toThrow();
});
it('limits a registration to its journal, operation and authenticated request',()=>{
  registerGeneratedJournal(ctx,control,journal,'journal.post');
  expect(()=>assertGeneratedJournal(ctx,control,journal,'journal.post')).not.toThrow();
  expect(()=>assertGeneratedJournal(ctx,control,'22222222-2222-4222-8222-222222222222','journal.post')).toThrow();
  expect(()=>assertGeneratedJournal(ctx,control,journal,'journal.reverse')).toThrow();
  expect(()=>assertGeneratedJournal({principal:{}} as ControlTx,control,journal,'journal.post')).toThrow();
});
it('revalidates the live parent permit after registration',()=>{
  registerGeneratedJournal(ctx,control,journal,'journal.post');
  mocks.assert.mockImplementationOnce(()=>{throw new Error('expired parent');});
  expect(()=>assertGeneratedJournal(ctx,control,journal,'journal.post')).toThrow('expired');
});
