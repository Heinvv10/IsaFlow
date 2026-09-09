import {beforeEach,expect,it,vi} from 'vitest';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
const material=vi.hoisted(()=>({period:vi.fn(),ap:vi.fn(),gl:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/periodOperationMaterializer',()=>({materializePeriodOperation:material.period}));
vi.mock('@/modules/accounting/services/controls/apOperationMaterializer',()=>({materializeApOperation:material.ap}));
vi.mock('@/modules/accounting/services/controls/glOperationMaterializer',()=>({materializeGlOperation:material.gl}));
import {materializeOperation} from '@/modules/accounting/services/controls/operationMaterializer';
beforeEach(()=>vi.clearAllMocks());
it.each(['fiscal_period','fiscal_year','vat_period','company_lockdown_intent'])('uses authoritative nonfinancial material for %s',async entityType=>{
 const ctx={} as ControlTx,ref={entityType,entityId:'synthetic',operation:'year.close' as const};
 material.period.mockResolvedValue({binding:{amount:null,currency:null}});
 expect(await materializeOperation(ctx,ref)).toEqual({binding:{amount:null,currency:null}});
 expect(material.period).toHaveBeenCalledWith(ctx,ref);expect(material.ap).not.toHaveBeenCalled();
});
