import {expect,it} from 'vitest';
import {prepareBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('requires an active issued transaction before preparing a reversal',async()=>{
 await expect(prepareBankAllocationReversal({} as ControlTx,{originalIntentId:'11111111-1111-4111-8111-111111111111',reversalDate:'2026-09-10',reason:'Correction'})).rejects.toThrow(/context|transaction|principal/i);
});
