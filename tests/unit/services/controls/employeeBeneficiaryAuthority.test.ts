import {beforeEach,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {proposeBeneficiaryChange} from '@/modules/accounting/services/controls/beneficiaryService';
const mocks=vi.hoisted(()=>({permission:vi.fn(),event:vi.fn()}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:mocks.permission}));
vi.mock('@/modules/accounting/services/controls/changeEventService',()=>({recordCommittedChange:mocks.event}));
vi.mock('@/modules/accounting/services/controls/beneficiaryQueries',()=>({lockBank:vi.fn().mockResolvedValue(null),pendingProposal:vi.fn().mockResolvedValue(null),latestVersion:vi.fn().mockResolvedValue(null),insertProposal:vi.fn()}));
const company='11111111-1111-4111-8111-111111111111',employee='22222222-2222-4222-8222-222222222222';
beforeEach(()=>{vi.clearAllMocks();process.env.ENCRYPTION_KEY=['synthetic','employee','evidence','key','32'].join('-');process.env.CONTROL_FINGERPRINT_KEY='synthetic-employee-fingerprint-key-32';});
it('employee beneficiary proposal also requires current payroll authority',async()=>{
 mocks.permission.mockImplementation(async(_ctx,p)=>{if(p==='write:payroll')throw new Error('Payroll denied');});
 await expect(withControlRequest({client:{query:vi.fn().mockResolvedValue({rows:[]})} as unknown as PoolClient,userId:'person',companyId:company,claims:{}},
  {personId:'person',companyId:company,authMethod:'cookie'},()=>proposeBeneficiaryChange(requireControlTx(),{entityType:'employee',entityId:employee},
   {bankName:'Synthetic',accountNumber:'00123456789',branchCode:'001234',accountType:'cheque'},[]))).rejects.toThrow('Payroll denied');
});
