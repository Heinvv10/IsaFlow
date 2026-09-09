import { expect, it, vi } from 'vitest';
import { buildYearEndFinancialMaterial } from '@/modules/accounting/services/controls/yearEndFinancialMaterial';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
const sources={company:{id:'company',default_currency:'ZAR',financial_year_start:1},
 periods:[{id:'p',start_date:'2026-01-01',end_date:'2026-12-31',status:'closed'}],
 journals:[{id:'j',status:'posted'}],lines:[{journal_entry_id:'j',gl_account_id:'revenue',debit:'0',credit:'100.01'},
 {journal_entry_id:'j',gl_account_id:'expense',debit:'40',credit:'0'}],
 accounts:[{id:'revenue',account_type:'revenue',is_active:true},{id:'expense',account_type:'expense',is_active:true}]};
function ctx(){return {principal:{companyId:'company'},sql:vi.fn(async()=>[{id:'retained',account_type:'equity',account_subtype:'retained_earnings',is_active:true}])} as unknown as ControlTx;}
it('binds exact fiscal-year closing money and retained earnings account',async()=>{
 expect(await buildYearEndFinancialMaterial(ctx(),'2026',sources)).toMatchObject({amount:'100.01',currency:'ZAR',netIncome:'60.01',retained:{id:'retained'}});
});
it('keeps zero-P&L explicit and refuses mismatched fiscal-year range',async()=>{
 expect(await buildYearEndFinancialMaterial(ctx(),'2026',{...sources,lines:[]})).toMatchObject({amount:'0',plan:[]});
 await expect(buildYearEndFinancialMaterial(ctx(),'2026',{...sources,company:{...sources.company,financial_year_start:3}})).rejects.toThrow();
});
