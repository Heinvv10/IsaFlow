import {expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const mocks=vi.hoisted(()=>({load:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/payrollControlQueries',()=>({loadPayrollControlPopulation:mocks.load}));
import {checkPayrollControls} from '@/modules/accounting/services/controls/payrollControlChecks';
import {payrollPopulation} from './payrollControlFixture';
it('reports complete source counts and exact totals separately from finding pagination',async()=>{
 mocks.load.mockResolvedValue({...payrollPopulation(),sourceTotals:{headerGross:'100.00',lineGross:'100.00',headerNet:'91.00',lineNet:'91.00'}});
 const result=await checkPayrollControls({principal:{companyId:'company'}} as ControlTx,{limit:1});
 expect(result.coverage).toContain('source_total:headerGross:100.00');expect(result.coverage).toContain('source_total:lineNet:91.00');
});
