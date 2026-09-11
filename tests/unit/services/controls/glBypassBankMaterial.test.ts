import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ assert: vi.fn(), version: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: mocks.assert }));
vi.mock('@/modules/accounting/services/controls/operationVersions', () => ({ readControlEntityVersion: mocks.version }));
import { BankTransferRefusalError, assertTransferAccountsActive, materializeBankTransferOperation } from '@/modules/accounting/services/controls/bankTransferOperationMaterializer';
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
it('refuses a bank account with no currency, or another currency, as a refusal that names the account',async()=>{
 const accounts=[{id:'a',account_code:'1000',account_name:'Main Cheque',account_subtype:'bank',is_active:true},{id:'b',account_code:'1010',account_name:'Savings',account_subtype:'bank',is_active:true}];
 const cases:[Record<string,unknown>,string][]=[
  [{accounts,banks:[{gl_account_id:'a',currency:null,is_active:true},{gl_account_id:'b',currency:'ZAR',is_active:true}]},
   'Cannot transfer between these bank accounts: 1000 Main Cheque has no currency set. Both must have the ledger currency (ZAR).'],
  [{accounts,banks:[{gl_account_id:'a',currency:'ZAR',is_active:true},{gl_account_id:'b',currency:'USD',is_active:true}]},
   'Cannot transfer between these bank accounts: 1010 Savings is in USD. Both must have the ledger currency (ZAR).'],
  [{accounts,banks:[{gl_account_id:'a',currency:'ZAR',is_active:true}]},
   'Cannot transfer between these bank accounts: 1010 Savings has no bank account record. Both must have the ledger currency (ZAR).'],
 ];
 for(const [override,message] of cases){
  const refused=materializeBankTransferOperation(context(override),ref);
  await expect(refused).rejects.toBeInstanceOf(BankTransferRefusalError);
  await expect(refused).rejects.toThrow(message);
 }
});
it('refuses what the company\'s rows do not allow with a 422 that names the problem',async()=>{
 const cases:[Record<string,unknown>,string][]=[
  [{accounts:[{id:'a',account_code:'1000',account_name:'Main Cheque',account_subtype:'bank',is_active:true},{id:'b',account_code:'1200',account_name:'Debtors',account_subtype:'receivable',is_active:true}]},
   'Cannot transfer between these accounts: 1200 Debtors is not a bank account.'],
  // Another tenant's account and an absent one read the same: the id is the caller's own input.
  [{accounts:[{id:'a',account_code:'1000',account_name:'Main Cheque',account_subtype:'bank',is_active:true}]},
   'Cannot transfer between these accounts: account b was not found in this company.'],
  [{company:{id,default_currency:null}},'Cannot transfer: this company has no default currency set. Set it before transferring between bank accounts.'],
  [{periods:[]},'Cannot transfer: no fiscal period covers 2026-09-30. Set up the fiscal year that contains this date first.'],
 ];
 for(const [override,message] of cases){
  const refused=materializeBankTransferOperation(context(override),ref);
  await expect(refused).rejects.toMatchObject({name:'BankTransferRefusalError',status:422,message});
 }
});
it('keeps overlapping fiscal periods a fault, not a refusal: the product never creates them',async()=>{
 const refused=materializeBankTransferOperation(context({periods:[{id:'p1'},{id:'p2'}]}),ref);
 await expect(refused).rejects.toThrow('Transfer fiscal period missing or ambiguous');
 await expect(refused).rejects.not.toBeInstanceOf(BankTransferRefusalError);
});
it('refuses to post from an account deactivated since preparation, naming it',()=>{
 const accounts=[{id:'a',account_code:'1000',account_name:'Main Cheque',is_active:false},{id:'b',account_code:'1010',account_name:'Savings',is_active:true}];
 const banks=[{gl_account_id:'a',is_active:true},{gl_account_id:'b',is_active:false}];
 expect(()=>assertTransferAccountsActive(accounts,banks)).toThrow(expect.objectContaining({name:'BankTransferRefusalError',status:422,
  message:'Cannot post this transfer: 1000 Main Cheque is inactive; 1010 Savings has an inactive bank account record.'}));
 expect(()=>assertTransferAccountsActive(accounts.map(a=>({...a,is_active:true})),banks.map(b=>({...b,is_active:true})))).not.toThrow();
});
