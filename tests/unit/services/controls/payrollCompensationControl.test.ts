import {expect,it} from 'vitest';
import {preparePayrollCompensation} from '@/modules/accounting/services/controls/payrollCompensationControl';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('refuses preparation without an issued current transaction before any database call',async()=>{
 await expect(preparePayrollCompensation({} as ControlTx,{})).rejects.toThrow(/context|issued|transaction/i);
});
