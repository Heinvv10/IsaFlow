import {expect,it} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
it('refuses unissued transaction context before any preparation SQL',async()=>{
 await expect(prepareCashApplication({} as ControlTx,{})).rejects.toThrow(/context|transaction|principal/i);
});

it('requires an issued transaction for CashApplication execution',async()=>{
 await expect(executeCashApplication({} as ControlTx,'00000000-0000-4000-8000-000000000000')).rejects.toThrow(/context|transaction|principal/i);
});
