import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {lockEmployeeBank} from '@/modules/accounting/services/controls/employeeBeneficiaryBank';
const query=vi.fn(),company='11111111-1111-4111-8111-111111111111',employee='22222222-2222-4222-8222-222222222222';
const bank={bankName:'Synthetic bank',accountNumber:'00123456789',branchCode:'001234',accountType:'cheque',future_effective:false};
let banks:Record<string,unknown>[];
function run(){return withControlRequest({client:{query} as unknown as PoolClient,userId:'person',companyId:company,claims:{}},
 {personId:'person',companyId:company,authMethod:'cookie'},()=>lockEmployeeBank(requireControlTx(),employee));}
beforeEach(()=>{banks=[bank];query.mockReset().mockImplementation(async(text:string)=>({rows:text.includes('FROM payroll_bank_details')?banks:text.includes('FROM payroll_employees')?[{id:employee}]:[]}));});
it('locks the payroll population before bank rows and returns only current internal details',async()=>{
 expect(await run()).toEqual({bankName:bank.bankName,accountNumber:bank.accountNumber,branchCode:bank.branchCode,accountType:bank.accountType});
 const statements=query.mock.calls.map(c=>String(c[0]));expect(statements.findIndex(s=>s.includes('pg_advisory_xact_lock'))).toBeLessThan(statements.findIndex(s=>s.includes('FROM payroll_employees')));
});
it('refuses multiple active or future-effective active records instead of choosing a bank',async()=>{
 banks=[bank,bank];await expect(run()).rejects.toThrow('AMBIGUOUS_BANKING');
 banks=[{...bank,future_effective:true}];await expect(run()).rejects.toThrow('FUTURE_EFFECTIVE_BANKING_UNSUPPORTED');
});
