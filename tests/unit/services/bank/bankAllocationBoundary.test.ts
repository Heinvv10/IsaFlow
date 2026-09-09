import {expect,it} from 'vitest';
import {executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('refuses an execution request without an issued active accounting context',async()=>{
 await expect(executeBankAllocation({} as ControlTx,'11111111-1111-4111-8111-111111111111')).rejects.toThrow(/context|transaction|principal/i);
});
