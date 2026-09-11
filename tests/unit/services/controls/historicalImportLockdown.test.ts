/** The historical import's lockdown refusal is the shared lockdownBlock rule, exercised unmocked. */
import {beforeEach,expect,it,vi} from 'vitest';
vi.mock('@/modules/accounting/services/controls/context',()=>({assertControlTx:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/historicalImportSettlementFacts',()=>({loadHistoricalSettlementFacts:vi.fn(async()=>[])}));
import {loadHistoricalImportCurrentFacts} from '@/modules/accounting/services/controls/historicalImportCurrentFacts';
import type {ControlTx} from '@/modules/accounting/services/controls/contracts';
import type {HistoricalImportNormalized} from '@/modules/accounting/services/controls/historicalImportTypes';
const COMPANY='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let company:Record<string,unknown>;
const sql=vi.fn(async(parts:TemplateStringsArray)=>{
 const text=parts.join('?');
 if(text.includes('FROM companies'))return[company];
 if(text.includes('FROM gl_accounts'))return[{id:'acc-1',account_code:'1000',account_name:'Bank',account_type:'asset',account_subtype:'bank',is_active:true,level:3},
  {id:'acc-2',account_code:'4000',account_name:'Sales',account_type:'revenue',account_subtype:null,is_active:true,level:3}];
 if(text.includes('FROM fiscal_periods'))return[{id:'period',start_date:'2026-09-01',end_date:'2026-09-30',status:'closed'}];
 return[];
});
const ctx={principal:{companyId:COMPANY,personId:'person'},sql} as unknown as ControlTx;
const source=(accountingDate:string):HistoricalImportNormalized=>({version:1,sourceSystem:'csv',sourceKey:'k',kind:'gl',mode:'post_journal',accountingDate,currency:'ZAR',amount:'10.00',
 records:[{recordId:'r1',accountCode:'1000',debit:'10.00',credit:'0',description:'Synthetic'},{recordId:'r2',accountCode:'4000',debit:'0',credit:'10.00',description:'Synthetic'}]});
beforeEach(()=>{company={id:COMPANY,default_currency:'ZAR',lockdown_enabled:true,lockdown_date:'2026-09-15'};});
it('refuses a historical date on or before a dated lockdown and accepts the day after',async()=>{
 await expect(loadHistoricalImportCurrentFacts(ctx,source('2026-09-15'))).rejects.toThrow('Historical date is within company lockdown');
 await expect(loadHistoricalImportCurrentFacts(ctx,source('2026-09-14'))).rejects.toThrow('Historical date is within company lockdown');
 await expect(loadHistoricalImportCurrentFacts(ctx,source('2026-09-16'))).resolves.toMatchObject({period:{id:'period'}});
});
it('refuses every historical date when lockdown is enabled with no date',async()=>{
 company.lockdown_date=null;
 await expect(loadHistoricalImportCurrentFacts(ctx,source('2026-09-16'))).rejects.toThrow('Historical date is within company lockdown');
});
it('accepts any date when lockdown is off',async()=>{
 company.lockdown_enabled=false;
 await expect(loadHistoricalImportCurrentFacts(ctx,source('2026-09-01'))).resolves.toMatchObject({period:{id:'period'}});
});
