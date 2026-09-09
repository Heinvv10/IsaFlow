import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({ctx:vi.fn(),permission:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mocks.ctx,assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
import {closeFiscalYear} from '@/modules/accounting/services/gl/controlledYearEnd';
beforeEach(()=>{vi.clearAllMocks();mocks.ctx.mockImplementation(()=>{throw new Error('Authenticated context required');});});
it('requires authenticated context for both preview and financial close',async()=>{
 await expect(closeFiscalYear('company','2026','person',{dryRun:true})).rejects.toThrow('Authenticated');
 await expect(closeFiscalYear('company','2026','person')).rejects.toThrow('Authenticated');
});
it('refuses actor substitution before querying the financial year',async()=>{
 mocks.ctx.mockReturnValue({principal:{companyId:'company',personId:'real'}});
 await expect(closeFiscalYear('company','2026','forged')).rejects.toThrow('match');
 expect(mocks.permission).not.toHaveBeenCalled();
});
