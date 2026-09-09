import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {withControlRequest} from '@/modules/accounting/services/controls/context';
import {createPayrollEmployee,updatePayrollEmployee} from '@/modules/accounting/services/payroll/payrollEmployeeService';
const mocks=vi.hoisted(()=>({query:vi.fn(),permission:vi.fn(),propose:vi.fn(),event:vi.fn(),bank:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/beneficiaryService',()=>({proposeBeneficiaryChange:mocks.propose}));
vi.mock('@/modules/accounting/services/controls/employeeBeneficiaryBank',()=>({lockEmployeeBank:mocks.bank}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:mocks.event}));
vi.mock('@/modules/accounting/services/controls/operationVersions',()=>({readControlEntityVersion:vi.fn().mockResolvedValue(null)}));
const company='11111111-1111-4111-8111-111111111111',employee='22222222-2222-4222-8222-222222222222';
const bank={bankName:'Synthetic',accountNumber:'00123456789',branchCode:'001234',accountType:'cheque'};
const input={employeeNumber:'E1',firstName:'Synthetic',lastName:'Employee',employmentType:'permanent' as const,startDate:new Date('2026-01-01'),uifExcluded:false,medicalAidMainMember:false,medicalAidDependantsCount:0};
const row={id:employee,company_id:company,employee_number:'E1',first_name:'Synthetic',last_name:'Employee',employment_type:'permanent',start_date:'2026-01-01',tax_number:'1234567890',status:'active'};
async function run<T>(fn:()=>Promise<T>){return withControlRequest({client:{query:mocks.query} as unknown as PoolClient,userId:'person',companyId:company,claims:{}},
 {personId:'person',companyId:company,authMethod:'cookie'},fn);}
beforeEach(()=>{
 vi.clearAllMocks();mocks.bank.mockResolvedValue(bank);mocks.propose.mockResolvedValue({proposalId:employee,status:'pending'});
 mocks.query.mockImplementation(async(text:string)=>({rows:text.includes('payroll_employees')?[row]:[]}));
});
it('banking create produces a bankless employee and an explicit pending proposal projection',async()=>{
 const result=await run(()=>createPayrollEmployee(company,{...input,bankDetails:bank}));
 expect(mocks.propose).toHaveBeenCalledOnce();expect(result).toMatchObject({id:employee,beneficiaryReview:{proposalId:employee,status:'pending'}});
 expect(mocks.event).toHaveBeenCalledOnce();expect(mocks.query.mock.calls.some(c=>String(c[0]).includes('INSERT INTO payroll_bank_details'))).toBe(false);
});
it('denies an unauthorized mixed employee/bank change before employee mutation',async()=>{
 mocks.permission.mockImplementation(async(_ctx,p)=>{if(p==='write:beneficiaries')throw new Error('Beneficiaries denied');});
 await expect(run(()=>updatePayrollEmployee(employee,company,{firstName:'Changed',bankDetails:{...bank,accountNumber:'00987654321'}}))).rejects.toThrow('Beneficiaries denied');
 expect(mocks.query.mock.calls.some(c=>String(c[0]).includes('UPDATE payroll_employees'))).toBe(false);
});
it('ordinary or unchanged-banking edits keep payroll-only compatibility and record exact employee evidence',async()=>{
 mocks.permission.mockImplementation(async(_ctx,p)=>{if(p==='write:beneficiaries')throw new Error('Beneficiaries denied');});
 await run(()=>updatePayrollEmployee(employee,company,{firstName:'Changed'}));
 await run(()=>updatePayrollEmployee(employee,company,{firstName:'Changed',bankDetails:bank}));
 expect(mocks.propose).not.toHaveBeenCalled();expect(mocks.event).toHaveBeenCalledTimes(2);
 expect(mocks.event.mock.calls[0]![1]).toMatchObject({entityType:'employee',entityId:employee,before:{tax_number:'1234567890'},after:{tax_number:'1234567890'}});
});
