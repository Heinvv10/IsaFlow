import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({ctx:{principal:{personId:'person'}},permission:vi.fn(),propose:vi.fn(),status:vi.fn()}));
vi.mock('@/modules/accounting/services/controls/context',()=>({requireControlTx:()=>m.ctx}));
vi.mock('@/lib/auth/effectivePermissions',()=>({assertEffectivePermission:m.permission}));
vi.mock('@/modules/accounting/services/controls/beneficiaryService',()=>({proposeBeneficiaryChange:m.propose}));
vi.mock('@/modules/accounting/services/controls/beneficiaryStatusService',()=>({readSupplierBankChangeStatus:m.status}));
import {forensicBeneficiaryTools} from '@/lib/mcp/tools/forensicBeneficiaries';
const id='11111111-1111-4111-8111-111111111111',ctx={userId:'person',companyId:id,scopes:[],tokenJti:null,oauthAppId:null};
const bank={bankName:'Synthetic bank',accountNumber:'1234567890',branchCode:'123456',accountType:'cheque'};
const input={supplier_id:id,bank,evidence_refs:[],idempotency_key:'retry'};
beforeEach(()=>vi.clearAllMocks());
it('proposes using the supplier-only shared interface without verification authority',async()=>{
 await forensicBeneficiaryTools[0].handler(input,ctx);
 expect(m.propose).toHaveBeenCalledWith(m.ctx,{entityType:'supplier',entityId:id},bank,[]);
 expect(forensicBeneficiaryTools.map(t=>t.name)).toEqual(['propose_supplier_bank_change','supplier_bank_change_status']);
 expect(forensicBeneficiaryTools[0].perUserIdempotency).toBe(true);
});
it('rechecks maintenance permission before cached replay and refuses revocation',async()=>{
 await forensicBeneficiaryTools[0].authorize!(input,ctx);
 expect(m.permission).toHaveBeenCalledWith(m.ctx,'write:beneficiaries');
 m.permission.mockRejectedValueOnce(new Error('revoked'));
 await expect(forensicBeneficiaryTools[0].authorize!(input,ctx)).rejects.toThrow('revoked');
 expect(m.propose).not.toHaveBeenCalled();
});
it('delegates status to the masked reader and preserves exact proposal association',async()=>{
 m.status.mockResolvedValue({supplierId:id,pendingHold:true,proposal:{accountLast4:'7890'}});
 const result=await forensicBeneficiaryTools[1].handler({supplier_id:id,proposal_id:id},ctx);
 expect(m.status).toHaveBeenCalledWith(m.ctx,{supplierId:id,proposalId:id});
 expect(JSON.stringify(result)).not.toContain(bank.accountNumber);
 expect(forensicBeneficiaryTools[1].scope).toBe('read:contacts');
});
it('rejects nested getters and unsupported actor authority without invoking getters',async()=>{
 const getter=vi.fn(()=>bank.accountNumber),unsafe={...bank};Object.defineProperty(unsafe,'accountNumber',{enumerable:true,get:getter});
 expect((await forensicBeneficiaryTools[0].handler({...input,bank:unsafe},ctx)).isError).toBe(true);
 expect(getter).not.toHaveBeenCalled();
 expect((await forensicBeneficiaryTools[0].handler({...input,verified:true},ctx)).isError).toBe(true);
 expect(m.propose).not.toHaveBeenCalled();
});
