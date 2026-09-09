import {expect,it} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
it('requires an issued transaction for inverse preparation',async()=>{
 await expect(prepareCashApplicationReversal({} as ControlTx,{})).rejects.toThrow(/context|transaction|principal/i);
});

it('requires an issued transaction for CashApplicationReversal execution',async()=>{
 await expect(executeCashApplicationReversal({} as ControlTx,'00000000-0000-4000-8000-000000000000')).rejects.toThrow(/context|transaction|principal/i);
});
