import {expect,it} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import {prepareCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
it('refuses unissued transaction context before any preparation SQL',async()=>{
 await expect(prepareCashApplication({} as ControlTx,{})).rejects.toThrow(/context|transaction|principal/i);
});
