import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ctx:vi.fn(),sql:vi.fn(),permission:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mocks.ctx,assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/lib/neon',()=>({sql:mocks.sql}));
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
