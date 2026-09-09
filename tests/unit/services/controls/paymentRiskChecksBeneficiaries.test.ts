import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sealBeneficiary} from '@/modules/accounting/services/controls/beneficiaryValidation';
import {detectSharedRiskBeneficiaries} from '@/modules/accounting/services/controls/paymentRiskChecksBeneficiaries';
beforeEach(()=>{vi.stubEnv('ENCRYPTION_KEY','synthetic-risk-check-32-character-key');vi.stubEnv('CONTROL_FINGERPRINT_KEY','synthetic-risk-fingerprint-key-32-characters');});
afterEach(()=>vi.unstubAllEnvs());
function row(){const id=randomUUID(),bank={bankName:'Synthetic',accountNumber:'12345678901',branchCode:'123456',accountType:'cheque'};
 const sealed=sealBeneficiary('company',{entityType:'supplier',entityId:id},bank);
 return{id,version_id:randomUUID(),version:1,details_envelope:sealed.envelope,fingerprint:sealed.fingerprint,pending:false,verified_at:'2026-09-09',
  bank_name:bank.bankName,bank_account_number:bank.accountNumber,bank_branch_code:bank.branchCode,bank_account_type:bank.accountType};}
it('matches separately sealed supplier versions without exposing banking details',()=>{
 const a=row(),b=row();expect(a.fingerprint).not.toBe(b.fingerprint);
 const result=detectSharedRiskBeneficiaries('company',[a,b]);expect(result.findings).toHaveLength(1);
 expect(JSON.stringify(result)).not.toContain('12345678901');expect(JSON.stringify(result)).not.toContain('123456');
 expect(result.findings[0]!.finding.classification).toBe('confirmed');
});
it('keeps foreign envelopes and unverified current edits unknown',()=>{
 const a=row(),b=row();expect(detectSharedRiskBeneficiaries('other',[a,b]).findings).toEqual([]);
 const result=detectSharedRiskBeneficiaries('company',[a,{...b,bank_account_number:'99999999999'}]);expect(result.findings).toEqual([]);expect(result.missing).toContain('supplier_bank_changed_outside_verified_version');
});
