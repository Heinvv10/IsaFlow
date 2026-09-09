import {expect,it} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {prepareCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
it('requires an issued transaction for inverse preparation',async()=>{
 await expect(prepareCashApplicationReversal({} as ControlTx,{})).rejects.toThrow(/context|transaction|principal/i);
});
