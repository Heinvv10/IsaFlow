import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ctx:vi.fn(),sql:vi.fn(),permission:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mocks.ctx,assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql,withSavepoint:(_name:string,fn:()=>Promise<unknown>)=>fn()}));
import { prepareBankTransfer, executeBankTransfer } from '@/modules/accounting/services/bank/bankTransferPostingService';
beforeEach(()=>{vi.clearAllMocks();mocks.ctx.mockImplementation(()=>{throw new Error('Authenticated context required');});});
it('requires real authenticated context before preparing or posting any transfer',async()=>{
 await expect(prepareBankTransfer('company','user',{fromAccountId:'a',toAccountId:'b',amount:'100',transferDate:'2026-02-28'})).rejects.toThrow('Authenticated');
 await expect(executeBankTransfer('company','user','intent')).rejects.toThrow('Authenticated');
 expect(mocks.sql).not.toHaveBeenCalled();
});
it('refuses person or tenant substitution before source access',async()=>{
 mocks.ctx.mockReturnValue({principal:{personId:'real',companyId:'company'}});
 await expect(executeBankTransfer('company','forged','intent')).rejects.toThrow('match');
 expect(mocks.permission).not.toHaveBeenCalled();expect(mocks.sql).not.toHaveBeenCalled();
});
it('refuses the person\'s own bad input with a 400 that names it, before any source access',async()=>{
 mocks.ctx.mockReturnValue({principal:{personId:'user',companyId:'company'},sql:mocks.sql});mocks.permission.mockResolvedValue(undefined);
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
 const cases:[Record<string,unknown>,string][]=[
  [{fromAccountId:a,toAccountId:a,amount:'100',transferDate:'2026-02-28'},'The from and to accounts must be different bank accounts'],
  [{fromAccountId:a,toAccountId:b,amount:'100',transferDate:'2026-02-30'},'The transfer date 2026-02-30 is not a real calendar date'],
  [{fromAccountId:a,toAccountId:b,amount:'abc',transferDate:'2026-02-28'},'Transfer amount must be a decimal number'],
  [{fromAccountId:a,toAccountId:b,amount:'0',transferDate:'2026-02-28'},'Transfer amount must be positive and expressed in cents'],
  [{fromAccountId:a,toAccountId:b,amount:'1.001',transferDate:'2026-02-28'},'Transfer amount must be positive and expressed in cents'],
 ];
 for(const [input,message] of cases){
  await expect(prepareBankTransfer('company','user',input as never)).rejects.toMatchObject({name:'BankTransferRefusalError',status:400,message});
 }
 expect(mocks.sql).not.toHaveBeenCalled();
});
it('prepares with an unlocked account check: a FOR SHARE here would take gl_accounts before the materializer\'s companies lock',async()=>{
 const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
 mocks.ctx.mockReturnValue({principal:{personId:'user',companyId:'company'},sql:mocks.sql});mocks.permission.mockResolvedValue(undefined);
 mocks.sql.mockImplementation(async(strings:TemplateStringsArray)=>{
  const query=strings.join('?');
  if(query.includes('FROM gl_accounts'))return [{id:a,account_subtype:'bank'},{id:b,account_subtype:'bank'}];
  if(query.includes('INSERT INTO control_bank_transfer_intents'))throw new Error('stop at the intent insert');
  return [];
 });
 await expect(prepareBankTransfer('company','user',{fromAccountId:a,toAccountId:b,amount:'1',transferDate:'2026-02-28'})).rejects.toThrow('stop at the intent insert');
 const issued=mocks.sql.mock.calls.map(([strings])=>(strings as TemplateStringsArray).join('?'));
 const check=issued.find(query=>query.includes('FROM gl_accounts'));
 expect(check,'no account check before the insert').toBeDefined();
 expect(check,'the pre-insert account check takes a row lock').not.toMatch(/FOR\s+SHARE|FOR\s+UPDATE/i);
});
