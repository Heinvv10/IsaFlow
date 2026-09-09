import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({ctx:vi.fn(),permission:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:mocks.ctx,assertControlTx:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
import { prepareAssetDepreciation, executeAssetDepreciation } from '@/modules/accounting/services/gl/controlledAssetDepreciation';
beforeEach(()=>{vi.clearAllMocks();mocks.ctx.mockImplementation(()=>{throw new Error('Authenticated context required');});});
it('requires an issued context before preparing or executing asset depreciation',async()=>{
 await expect(prepareAssetDepreciation('company','user','asset','2026-02-28')).rejects.toThrow('Authenticated');
 await expect(executeAssetDepreciation('company','user','intent')).rejects.toThrow('Authenticated');
});
it('refuses substituted people before reading any asset',async()=>{
 mocks.ctx.mockReturnValue({principal:{personId:'real',companyId:'company'}});
 await expect(prepareAssetDepreciation('company','forged','asset','2026-02-28')).rejects.toThrow('match');
 expect(mocks.permission).not.toHaveBeenCalled();
});
