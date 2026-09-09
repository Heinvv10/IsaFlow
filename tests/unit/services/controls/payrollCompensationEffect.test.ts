import {expect,it} from 'vitest';
import {executePayrollCompensationEffect} from '@/modules/accounting/services/controls/payrollCompensationEffect';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {ControlledEffectPermit} from '@/modules/accounting/services/controls/approvalExecutionService';
it('refuses direct private compensation writes without an issued context and permit',async()=>{
 await expect(executePayrollCompensationEffect({} as ControlTx,'invalid',{} as ControlledEffectPermit)).rejects.toThrow(/context|issued|transaction|permit/i);
});
