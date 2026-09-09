import { expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({financial:vi.fn(async()=>({amount:'100',currency:'ZAR',plan:[]}))}));
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:vi.fn(async()=>null)}));
vi.mock('@/modules/accounting/services/controls/yearEndFinancialMaterial',()=>({buildYearEndFinancialMaterial:mocks.financial}));
vi.mock('@/modules/accounting/services/reports/vat201ReportService',()=>({getVat201Report:vi.fn()}));
import { materializePeriodOperation } from '@/modules/accounting/services/controls/periodOperationMaterializer';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
it('binds financial year.close amount and currency to actual closing material',async()=>{
 const sql=vi.fn(async(strings:TemplateStringsArray)=>{
  const query=strings.join('?');
  if(query.includes('FROM companies'))return [{id:'company',default_currency:'ZAR',financial_year_start:1}];
  if(query.includes('FROM fiscal_periods'))return [{id:'period',start_date:'2026-01-01',end_date:'2026-12-31',status:'closed'}];
  if(query.includes('FROM gl_journal_entries'))return [];
  throw new Error('Unexpected SQL');
 });
 const ctx={principal:{companyId:'company'},sql} as unknown as ControlTx;
 const result=await materializePeriodOperation(ctx,{entityType:'fiscal_year',entityId:'2026',operation:'year.close'});
 expect(result.binding).toMatchObject({amount:'100',currency:'ZAR'});
 expect(mocks.financial).toHaveBeenCalledOnce();
 expect(result.observedSources[0]!.facts).toMatchObject({closing:{amount:'100',currency:'ZAR'}});
});
