import {expect,it} from 'vitest';
import {loadPayrollCompensationIntent,materializePayrollCompensationOperation} from '@/modules/accounting/services/controls/payrollCompensationMaterial';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('requires issued context for material loading',async()=>{
 await expect(loadPayrollCompensationIntent({} as ControlTx,'invalid')).rejects.toThrow(/context|issued|transaction/i);
});
it('refuses unrelated operation materialization',async()=>{
 await expect(materializePayrollCompensationOperation({} as ControlTx,{entityType:'customer_invoice',entityId:'invalid',operation:'customer_invoice.post'})).rejects.toThrow(/Unsupported/);
});
