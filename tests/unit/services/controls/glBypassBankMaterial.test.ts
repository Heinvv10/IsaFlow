import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ assert: vi.fn(), version: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: mocks.assert }));
vi.mock('@/modules/accounting/services/controls/operationVersions', () => ({ readControlEntityVersion: mocks.version }));
import { materializeBankTransferOperation } from '@/modules/accounting/services/controls/bankTransferOperationMaterializer';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
const id='11111111-1111-1111-1111-111111111111';
const ref:OperationRef={entityType:'bank_transfer_intent',entityId:id,operation:'bank_transfer.post'};
function context(overrides: Record<string, unknown> = {}) {
 const facts={company:{id,default_currency:'ZAR'},intent:{id,from_gl_account_id:'a',to_gl_account_id:'b',amount:'9007199254740993.01',accounting_date:'2026-09-30'},
  accounts:[{id:'a',account_subtype:'bank',is_active:true},{id:'b',account_subtype:'bank',is_active:true}],
  banks:[{gl_account_id:'a',currency:'ZAR',is_active:true},{gl_account_id:'b',currency:'ZAR',is_active:true}],
  periods:[{id:'period',status:'open'}],...overrides};
 const sql=vi.fn(async (strings:TemplateStringsArray)=>{
  const query=strings.join('?');
  if(query.includes('FROM companies')) return [facts.company];
  if(query.includes('FROM control_bank_transfer_intents')) return [facts.intent];
  if(query.includes('FROM gl_accounts')) return facts.accounts;
  if(query.includes('FROM bank_accounts')) return facts.banks;
  if(query.includes('FROM fiscal_periods')) return facts.periods;
  throw new Error('Unexpected SQL');
 });
 return {principal:{companyId:id},sql} as unknown as ControlTx;
}
beforeEach(()=>vi.clearAllMocks());
it('binds exact persisted transfer intent and current source facts',async()=>{
 const material=await materializeBankTransferOperation(context(),ref);
 expect(material.binding).toMatchObject({amount:'9007199254740993.01',currency:'ZAR',accountingDate:'2026-09-30'});
 expect(material.observedSources[0]!.facts).toMatchObject({plan:[{glAccountId:'b',debit:'9007199254740993.01',credit:'0'},{glAccountId:'a',debit:'0',credit:'9007199254740993.01'}]});
});
it('rejects unknown or mismatched currency and foreign accounts before binding',async()=>{
 for(const override of [{banks:[]},{banks:[{gl_account_id:'a',currency:'USD',is_active:true},{gl_account_id:'b',currency:'ZAR',is_active:true}]},{accounts:[{id:'a'}]}]) {
  await expect(materializeBankTransferOperation(context(override),ref)).rejects.toThrow();
 }
});
it('rejects forged contexts before reading sources',async()=>{
 const ctx=context();mocks.assert.mockImplementationOnce(()=>{throw new Error('forged');});
 await expect(materializeBankTransferOperation(ctx,ref)).rejects.toThrow('forged');expect(ctx.sql).not.toHaveBeenCalled();
});
