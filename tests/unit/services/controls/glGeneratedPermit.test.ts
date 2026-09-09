import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(()=>({assert:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/approvalExecutionService',()=>({assertControlledEffectPermit:mocks.assert}));
import { registerGeneratedJournal, assertGeneratedJournal } from '@/modules/accounting/services/controls/generatedJournalPermit';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
import type { ControlledEffectPermit } from '@/modules/accounting/services/controls/approvalExecutionService';
const journal='11111111-1111-4111-8111-111111111111';
const parent={entityType:'supplier_invoice',entityId:journal,operation:'supplier_invoice.post'} as OperationRef;
const permit={accountingDate:'2026-09-09'} as ControlledEffectPermit, control={permit,parent};
const sql=vi.fn(async()=>[{id:journal,entry_date:'2026-09-09'}]);
const ctx={principal:{},sql} as unknown as ControlTx;
beforeEach(()=>{vi.clearAllMocks();sql.mockResolvedValue([{id:journal,entry_date:'2026-09-09'}]);});
it('refuses an unregistered journal even inside a valid parent callback',()=>{
  expect(()=>assertGeneratedJournal(ctx,control,journal,'journal.post')).toThrow();
});
it('limits a registration to its journal, operation and authenticated request',async()=>{
  await registerGeneratedJournal(ctx,control,journal,'journal.post');
  expect(()=>assertGeneratedJournal(ctx,control,journal,'journal.post')).not.toThrow();
  expect(()=>assertGeneratedJournal(ctx,control,'22222222-2222-4222-8222-222222222222','journal.post')).toThrow();
  expect(()=>assertGeneratedJournal(ctx,control,journal,'journal.reverse')).toThrow();
  expect(()=>assertGeneratedJournal({principal:{}} as ControlTx,control,journal,'journal.post')).toThrow();
});
it('revalidates the live parent permit after registration',async()=>{
  await registerGeneratedJournal(ctx,control,journal,'journal.post');
  mocks.assert.mockImplementationOnce(()=>{throw new Error('expired parent');});
  expect(()=>assertGeneratedJournal(ctx,control,journal,'journal.post')).toThrow('expired');
});

it('refuses registering a journal without a persisted owned parent relationship',async()=>{
  sql.mockResolvedValue([]);
  await expect(registerGeneratedJournal(ctx,control,journal,'journal.post')).rejects.toThrow('parent');
});

it.each([
  ['supplier_invoice','supplier_invoice.post'],
  ['supplier_invoice','supplier_invoice.approve'],
  ['supplier_invoice','supplier_invoice.cancel'],
  ['supplier_payment','supplier_payment.process'],
  ['supplier_payment','supplier_payment.void'],
  ['journal_entry','journal.reverse'],
])('refuses a related %s child posted outside its %s bound date',async(entityType,operation)=>{
  sql.mockResolvedValue([{id:journal,entry_date:'2026-09-10'}]);
  const parent={entityType,entityId:journal,operation} as OperationRef;
  await expect(registerGeneratedJournal(ctx,{permit,parent},journal,'journal.post')).rejects.toThrow('date');
});
it('allows reversing the owned original with a different original date',async()=>{
  sql.mockResolvedValue([{id:journal,entry_date:'2026-09-01'}]);
  const parent={entityType:'supplier_invoice',entityId:journal,operation:'supplier_invoice.cancel'} as OperationRef;
  await expect(registerGeneratedJournal(ctx,{permit,parent},journal,'journal.reverse')).resolves.toBeUndefined();
});
