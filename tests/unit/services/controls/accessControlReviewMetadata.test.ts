import {expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const mocks=vi.hoisted(()=>({assert:vi.fn(),permission:vi.fn(),connect:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:mocks.assert}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/accessControlReviewPool',()=>({getAccessReviewPool:()=>({connect:mocks.connect})}));
import {readAccessReviewMetadata} from '@/modules/accounting/services/controls/accessControlReviewMetadata';
it('never acquires privileged metadata access before issued current read authority',async()=>{
 mocks.permission.mockRejectedValueOnce(new Error('Current permission denied'));
 await expect(readAccessReviewMetadata({} as ControlTx,{kind:'pat',limit:1,dormantDays:90,after:null})).rejects.toThrow('Current permission denied');
 expect(mocks.permission).toHaveBeenCalledWith({},'read:access');expect(mocks.connect).not.toHaveBeenCalled();
});
it('releases a private metadata client when the read-only transaction cannot start',async()=>{
 mocks.permission.mockResolvedValue(undefined);const release=vi.fn(),query=vi.fn().mockRejectedValue(new Error('Synthetic BEGIN failure'));
 mocks.connect.mockResolvedValue({query,release});
 await expect(readAccessReviewMetadata({principal:{companyId:'11111111-1111-4111-8111-111111111111'}} as ControlTx,{kind:'pat',limit:1,dormantDays:90,after:null})).rejects.toThrow('Synthetic BEGIN failure');
 expect(release).toHaveBeenCalledOnce();
});
it('destroys a client whose rollback fails instead of returning an unusable transaction to the pool',async()=>{
 mocks.permission.mockResolvedValue(undefined);const release=vi.fn();
 const query=vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]})
  .mockRejectedValueOnce(new Error('Synthetic read failure')).mockRejectedValueOnce(new Error('Synthetic rollback failure'));
 mocks.connect.mockResolvedValue({query,release});
 await expect(readAccessReviewMetadata({principal:{companyId:'11111111-1111-4111-8111-111111111111'}} as ControlTx,{kind:'pat',limit:1,dormantDays:90,after:null})).rejects.toThrow('Access metadata rollback failed');
 expect(release).toHaveBeenCalledWith(true);
});
