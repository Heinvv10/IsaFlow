import { expect, it, vi } from 'vitest';
const run=vi.hoisted(()=>vi.fn(async()=>[]));
vi.mock('@/modules/accounting/services/controls/periodControl',()=>({runPeriodControl:run}));
import {closeYear} from '@/modules/accounting/services/gl/fiscalPeriodControlService';
it('uses a separate nonfinancial operation for bulk period closure',async()=>{
 await closeYear('company',2026,'person');
 expect(run).toHaveBeenCalledWith('company',{entityType:'fiscal_year',entityId:'2026',operation:'year.periods_close'},undefined,expect.any(Function),'person');
});
