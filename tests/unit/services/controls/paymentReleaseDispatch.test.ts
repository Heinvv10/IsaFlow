import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({observe:vi.fn(),permission:vi.fn(),require:vi.fn(),connect:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn(),withControlRequest:vi.fn(),requireControlTx:mocks.require}));
vi.mock('@/modules/accounting/services/controls/transactionObservers',()=>({observeControlTransaction:mocks.observe,settleControlTransaction:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('pg',async importOriginal=>({...await importOriginal<typeof import('pg')>(),Pool:class{connect=mocks.connect;end=vi.fn();on=vi.fn();}}));
import {schedulePaymentReleaseDispatch} from '@/modules/accounting/services/ap/paymentReleaseDispatcher';
beforeEach(()=>vi.clearAllMocks());
it('does not connect or transmit when the originating transaction rolls back or is unknown',async()=>{
 const ctx={principal:{companyId:'company',personId:'person',authMethod:'cookie',connectionId:null,grantId:null,grantedScopes:null},sql:vi.fn().mockResolvedValue([{requester_person_id:'person'}])};
 await schedulePaymentReleaseDispatch(ctx as never,'11111111-1111-4111-8111-111111111111');
 const callback=mocks.observe.mock.calls[0]![0];await callback('rolled_back');await callback('unknown');
 expect(mocks.connect).not.toHaveBeenCalled();
});
